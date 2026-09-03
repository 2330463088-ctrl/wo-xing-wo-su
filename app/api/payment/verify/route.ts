/**
 * 付款截图 OCR 自动开通接口
 *
 * 流程：
 * 1. 接收 base64 截图 + 用户邮箱
 * 2. 调用百度 OCR 识别文字
 * 3. 从 OCR 结果中提取：付款金额、收款人、交易单号 / 商户单号
 * 4. 校验：金额 >= 99 元 & 单号未使用过 & 收款人匹配预设收款人
 * 5. 写入 payments 表 & 开通 / 延长会员（更新 users 表 is_vip / vip_expires_at）
 * 6. 返回开通结果
 */

// ========= 类型 =========
type OcrWordResult = { words: string };
type BaiduOcrResponse = {
  words_result?: OcrWordResult[];
  words_result_num?: number;
  error_code?: number;
  error_msg?: string;
};

type PaymentRow = {
  id?: string;
  user_email: string;
  amount: number;
  payee_name: string;
  transaction_id: string;
  merchant_order_id?: string | null;
  ocr_raw_text?: string | null;
  screenshot_url?: string | null;
  status: "pending" | "approved" | "rejected";
  reject_reason?: string | null;
  approved_at?: string | null;
  created_at?: string;
};

type UserRow = {
  id?: string;
  email: string;
  display_name?: string | null;
  is_vip: boolean;
  vip_expires_at?: string | null;
  total_paid?: number;
  created_at?: string;
  updated_at?: string;
};

// ========= 通用工具 =========
function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, x-user-email",
    "Cache-Control": "no-store",
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function readEnv(name: string): string {
  return String(process.env[name] || "").trim();
}

function normalizeEmail(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

// ========= Supabase 封装 =========
function getSupabaseConfig() {
  const url = readEnv("SUPABASE_URL").replace(/\/+$/, "");
  const serviceRoleKey = readEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceRoleKey) return null;
  return { url, serviceRoleKey };
}

async function supabaseRequest(
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const config = getSupabaseConfig();
  if (!config) {
    return jsonResponse(
      { ok: false, message: "Supabase 未配置" },
      500
    );
  }
  return fetch(`${config.url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers || {}),
    },
  });
}

/**
 * 自动建表（幂等）
 * 通过 Supabase REST 的 rpc 调用自定义函数来建表；
 * 如果函数不存在，则用一个简单的 fallback：尝试查询表，若报错说明表不存在，
 * 就通过匿名的 SQL 通道…… 其实 Supabase REST 不能执行 DDL。
 * 所以这里我们通过 rpc 调一个我们预先创建的 SQL 函数来建表。
 * 为了让用户开箱即用，我们先尝试查询，如果表不存在，返回明确的错误提示让用户去建表。
 */
async function ensureTables(): Promise<{ ok: boolean; error?: string }> {
  // 先尝试查询 users 表，如果 404 或报错说明表不存在
  const test = await supabaseRequest("users?limit=1&select=id");
  if (test.ok) return { ok: true };

  const test2 = await supabaseRequest("payments?limit=1&select=id");
  if (test2.ok) return { ok: true };

  // 尝试自动建表：通过 Supabase 的 SQL API（需要项目启用了 SQL Editor API）
  // 大多数项目默认不开放，所以我们返回提示
  return { ok: false, error: "users 或 payments 表不存在，需要先在 Supabase 中创建" };
}

// ========= 百度 OCR =========
let cachedBaiduToken: { token: string; expiresAt: number } | null = null;

async function getBaiduAccessToken(): Promise<string> {
  const apiKey = readEnv("BAIDU_OCR_API_KEY");
  const secretKey = readEnv("BAIDU_OCR_SECRET_KEY");

  if (!apiKey || !secretKey) {
    throw new Error("百度 OCR 未配置");
  }

  const now = Date.now();
  if (cachedBaiduToken && cachedBaiduToken.expiresAt > now + 60000) {
    return cachedBaiduToken.token;
  }

  const url = `https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${encodeURIComponent(
    apiKey
  )}&client_secret=${encodeURIComponent(secretKey)}`;

  const resp = await fetch(url, { method: "POST" });
  const data = (await resp.json()) as { access_token?: string; expires_in?: number; error?: string };

  if (!data.access_token || data.error) {
    throw new Error(`百度 OCR Token 获取失败: ${data.error || "未知错误"}`);
  }

  cachedBaiduToken = {
    token: data.access_token,
    expiresAt: now + (data.expires_in || 2592000) * 1000,
  };

  return cachedBaiduToken.token;
}

async function ocrRecognize(imageBase64: string): Promise<string[]> {
  const token = await getBaiduAccessToken();
  const url = `https://aip.baidubce.com/rest/2.0/ocr/v1/general_basic?access_token=${token}`;

  const body = new URLSearchParams();
  body.append("image", imageBase64);

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const data = (await resp.json()) as BaiduOcrResponse;

  if (data.error_code) {
    throw new Error(`OCR 识别失败: ${data.error_msg} (code: ${data.error_code})`);
  }

  return (data.words_result || []).map((w) => w.words);
}

// ========= OCR 结果解析 =========
type PaymentInfo = {
  amount: number | null;        // 付款金额（元）
  payeeName: string | null;     // 收款人姓名
  transactionId: string | null; // 交易单号
  merchantOrderId: string | null; // 商户单号
};

/**
 * 从 OCR 识别出的多行文字中提取付款信息
 * 支持微信支付、支付宝等常见转账截图格式
 */
function extractPaymentInfo(lines: string[]): PaymentInfo {
  const result: PaymentInfo = {
    amount: null,
    payeeName: null,
    transactionId: null,
    merchantOrderId: null,
  };

  const fullText = lines.join("\n");

  // 1. 提取金额
  // 匹配：¥99.00、￥99.00、99.00元、转账金额 ¥99.00、付款金额 99.00 等
  const amountPatterns = [
    /付款金额[^\d]*¥?\s*([\d,]+\.?\d*)/i,
    /转账金额[^\d]*¥?\s*([\d,]+\.?\d*)/i,
    /实付金额[^\d]*¥?\s*([\d,]+\.?\d*)/i,
    /支付金额[^\d]*¥?\s*([\d,]+\.?\d*)/i,
    /金额[^\d]*¥?\s*([\d,]+\.?\d*)/i,
    /付款成功[^\d]*¥?\s*([\d,]+\.?\d*)/i,
    /转账成功[^\d]*¥?\s*([\d,]+\.?\d*)/i,
    /已支付[^\d]*¥?\s*([\d,]+\.?\d*)/i,
    /^[¥￥]\s*([\d,]+\.?\d{2})$/m,
    /([\d,]+\.\d{2})\s*元/,
  ];

  for (const pattern of amountPatterns) {
    const match = fullText.match(pattern);
    if (match) {
      const num = parseFloat(match[1].replace(/,/g, ""));
      if (!isNaN(num) && num > 0) {
        result.amount = num;
        break;
      }
    }
  }

  // 2. 提取收款人
  const payeePatterns = [
    /收款方[：:]\s*([^\n]+)/i,
    /收款人[：:]\s*([^\n]+)/i,
    /收款[：:]\s*([^\n]+)/i,
    /向\s*([^\n\s]+)\s*转账/,
    /对方[：:]\s*([^\n]+)/i,
    /转给[：:]\s*([^\n]+)/i,
    /收钱方[：:]\s*([^\n]+)/i,
    /(?:到账|存入)[：:]\s*([^\n]+)/i,
  ];

  for (const pattern of payeePatterns) {
    const match = fullText.match(pattern);
    if (match) {
      let name = match[1].trim();
      // 去掉尾部常见的无关内容
      name = name.replace(/\s*(微信|支付宝|账户|银行|卡号).*$/i, "").trim();
      name = name.replace(/[\s|│|▏|▎|▍|▌|▊|▉].*$/, "").trim();
      if (name && name.length <= 20) {
        result.payeeName = name;
        break;
      }
    }
  }

  // 3. 提取交易单号 / 订单号
  const txnPatterns = [
    /交易单号[：:]\s*([A-Za-z0-9_\-]+)/i,
    /交易流水号[：:]\s*([A-Za-z0-9_\-]+)/i,
    /订单号[：:]\s*([A-Za-z0-9_\-]+)/i,
    /支付单号[：:]\s*([A-Za-z0-9_\-]+)/i,
    /微信支付单号[：:]\s*([A-Za-z0-9_\-]+)/i,
    /商户单号[：:]\s*([A-Za-z0-9_\-]+)/i,
    /流水号[：:]\s*([A-Za-z0-9_\-]+)/i,
    /转账单号[：:]\s*([A-Za-z0-9_\-]+)/i,
    /单号[：:]\s*([A-Za-z0-9_\-]+)/i,
  ];

  for (const pattern of txnPatterns) {
    const match = fullText.match(pattern);
    if (match) {
      const id = match[1].trim();
      if (id.length >= 8) {
        // 判断是交易单号还是商户单号
        const labelMatch = pattern.source.match(/^\/(.+?)[：:]/);
        const label = labelMatch ? labelMatch[1] : "";
        if (/商户/.test(label)) {
          result.merchantOrderId = id;
        } else {
          if (!result.transactionId) {
            result.transactionId = id;
          } else if (!result.merchantOrderId) {
            result.merchantOrderId = id;
          }
        }
        break;
      }
    }
  }

  // 如果只有商户单号没有交易单号，反过来也一样
  if (!result.transactionId && result.merchantOrderId) {
    result.transactionId = result.merchantOrderId;
  }

  return result;
}

// ========= 业务校验 & 开通 =========

/**
 * 预设收款人名单（可以通过环境变量配置，逗号分隔）
 * 例如：PAYEE_NAMES=张三,李四
 */
function getAllowedPayeeNames(): string[] {
  const raw = readEnv("PAYEE_NAMES");
  if (!raw) {
    // 默认：如果没有配置，则不校验收款人，只校验金额
    return [];
  }
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function getMembershipPrice(): number {
  const raw = readEnv("MEMBERSHIP_PRICE");
  const price = parseFloat(raw);
  return price > 0 ? price : 99; // 默认 99 元
}

function getMembershipDays(): number {
  const raw = readEnv("MEMBERSHIP_DAYS");
  const days = parseInt(raw, 10);
  return days > 0 ? days : 365; // 默认 365 天
}

/**
 * 检查单号是否已使用过（防止同一张截图重复开通）
 */
async function isTransactionIdUsed(transactionId: string): Promise<boolean> {
  if (!transactionId) return false;
  const resp = await supabaseRequest(
    `payments?transaction_id=eq.${encodeURIComponent(transactionId)}&status=eq.approved&limit=1&select=id`
  );
  if (!resp.ok) return false;
  const data = (await resp.json()) as { id?: string }[];
  return Array.isArray(data) && data.length > 0;
}

/**
 * 查找或创建用户
 */
async function upsertUser(email: string, displayName?: string | null): Promise<UserRow | null> {
  const now = new Date().toISOString();

  // 先尝试 upsert
  const row: Partial<UserRow> = {
    email,
    display_name: displayName || null,
    is_vip: false,
    total_paid: 0,
    updated_at: now,
  };

  const resp = await supabaseRequest("users?on_conflict=email", {
    method: "POST",
    headers: {
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify(row),
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error("upsertUser failed:", resp.status, text);
    return null;
  }

  const data = (await resp.json()) as UserRow[];
  return data[0] || null;
}

/**
 * 创建付款记录
 */
async function createPayment(payment: PaymentRow): Promise<PaymentRow | null> {
  const resp = await supabaseRequest("payments", {
    method: "POST",
    body: JSON.stringify(payment),
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error("createPayment failed:", resp.status, text);
    return null;
  }

  const data = (await resp.json()) as PaymentRow[];
  return data[0] || null;
}

/**
 * 开通会员：更新用户 vip 状态，同时更新付款记录状态
 */
async function approveMembership(
  email: string,
  amount: number,
  paymentId: string
): Promise<{ ok: boolean; expiresAt?: string }> {
  const now = new Date();
  const days = getMembershipDays();
  const expireDate = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const expiresAt = expireDate.toISOString();
  const approvedAt = now.toISOString();

  // 1. 获取当前用户
  const userResp = await supabaseRequest(
    `users?email=eq.${encodeURIComponent(email)}&limit=1&select=*`
  );
  if (!userResp.ok) {
    return { ok: false };
  }
  const users = (await userResp.json()) as UserRow[];
  const user = users[0];
  if (!user) {
    return { ok: false };
  }

  // 2. 计算新的到期时间（如果已在有效期内，则累加）
  let newExpiresAt = expiresAt;
  if (user.is_vip && user.vip_expires_at && new Date(user.vip_expires_at) > now) {
    const currentExpire = new Date(user.vip_expires_at);
    newExpiresAt = new Date(currentExpire.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
  }

  // 3. 更新用户
  const totalPaid = (user.total_paid || 0) + amount;
  const updateResp = await supabaseRequest(
    `users?email=eq.${encodeURIComponent(email)}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        is_vip: true,
        vip_expires_at: newExpiresAt,
        total_paid: totalPaid,
        updated_at: approvedAt,
      }),
    }
  );

  if (!updateResp.ok) {
    return { ok: false };
  }

  // 4. 更新付款记录状态
  const payUpdateResp = await supabaseRequest(
    `payments?id=eq.${encodeURIComponent(paymentId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        status: "approved",
        approved_at: approvedAt,
      }),
    }
  );

  if (!payUpdateResp.ok) {
    // 不影响主流程，但记日志
    console.warn("更新付款记录状态失败");
  }

  return { ok: true, expiresAt: newExpiresAt };
}

// ========= 主入口 =========

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as {
      image?: string;         // base64 图片（不含 data:image/... 前缀）
      imageDataUrl?: string;  // 完整 data URL
      email?: string;
      displayName?: string;
    } | null;

    if (!body) {
      return jsonResponse({ ok: false, message: "请求体为空" }, 400);
    }

    const email = normalizeEmail(
      body.email || request.headers.get("x-user-email")
    );

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return jsonResponse({ ok: false, message: "请先登录" }, 401);
    }

    // 解析图片
    let imageBase64 = "";
    if (body.imageDataUrl) {
      const match = body.imageDataUrl.match(/^data:image\/[^;]+;base64,(.+)$/);
      if (match) {
        imageBase64 = match[1];
      }
    }
    if (!imageBase64 && body.image) {
      imageBase64 = body.image;
    }
    if (!imageBase64) {
      return jsonResponse({ ok: false, message: "请上传付款截图" }, 400);
    }

    // 确保表存在
    const tableCheck = await ensureTables();
    if (!tableCheck.ok) {
      return jsonResponse(
        {
          ok: false,
          message: "数据库表未初始化",
          detail: tableCheck.error,
          needSetup: true,
        },
        500
      );
    }

    // 1. OCR 识别
    let ocrLines: string[];
    try {
      ocrLines = await ocrRecognize(imageBase64);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "OCR 识别失败";
      return jsonResponse({ ok: false, message: msg, stage: "ocr" }, 500);
    }

    if (!ocrLines || ocrLines.length === 0) {
      return jsonResponse(
        { ok: false, message: "未能识别出文字，请上传清晰的付款截图", stage: "ocr" },
        400
      );
    }

    const fullText = ocrLines.join("\n");

    // 2. 提取付款信息
    const info = extractPaymentInfo(ocrLines);

    // 3. 校验

    // 3.1 金额校验
    const minPrice = getMembershipPrice();
    if (info.amount === null || info.amount < minPrice) {
      return jsonResponse({
        ok: false,
        message: `付款金额不足${minPrice}元，识别到的金额：${info.amount !== null ? info.amount + "元" : "未识别到"}`,
        stage: "verify",
        ocrText: fullText,
        extracted: info,
      }, 400);
    }

    // 3.2 单号校验
    if (!info.transactionId) {
      return jsonResponse({
        ok: false,
        message: "未能识别交易单号，请确保截图包含完整的交易单号",
        stage: "verify",
        ocrText: fullText,
        extracted: info,
      }, 400);
    }

    // 3.3 单号去重
    const used = await isTransactionIdUsed(info.transactionId);
    if (used) {
      return jsonResponse({
        ok: false,
        message: "该交易单号已用于开通会员，请勿重复提交",
        stage: "verify",
        extracted: info,
      }, 400);
    }

    // 3.4 收款人校验（如果配置了）
    const allowedPayees = getAllowedPayeeNames();
    if (allowedPayees.length > 0 && info.payeeName) {
      const matched = allowedPayees.some(
        (name) => info.payeeName && info.payeeName.includes(name)
      );
      if (!matched) {
        return jsonResponse({
          ok: false,
          message: `收款人不匹配，识别到的收款人：${info.payeeName}`,
          stage: "verify",
          ocrText: fullText,
          extracted: info,
        }, 400);
      }
    }

    // 4. 确保用户存在
    const user = await upsertUser(email, body.displayName || null);
    if (!user) {
      return jsonResponse({ ok: false, message: "用户创建失败" }, 500);
    }

    // 5. 创建付款记录（pending 状态）
    const payment = await createPayment({
      user_email: email,
      amount: info.amount,
      payee_name: info.payeeName || "",
      transaction_id: info.transactionId,
      merchant_order_id: info.merchantOrderId || null,
      ocr_raw_text: fullText,
      status: "pending",
    });

    if (!payment || !payment.id) {
      return jsonResponse({ ok: false, message: "付款记录创建失败" }, 500);
    }

    // 6. 开通会员
    const result = await approveMembership(email, info.amount, payment.id);
    if (!result.ok) {
      return jsonResponse({ ok: false, message: "会员开通失败" }, 500);
    }

    return jsonResponse({
      ok: true,
      message: "会员开通成功",
      data: {
        amount: info.amount,
        payeeName: info.payeeName,
        transactionId: info.transactionId,
        merchantOrderId: info.merchantOrderId,
        expiresAt: result.expiresAt,
        days: getMembershipDays(),
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "未知错误";
    console.error("payment verify error:", msg, e);
    return jsonResponse({ ok: false, message: `处理失败：${msg}` }, 500);
  }
}
