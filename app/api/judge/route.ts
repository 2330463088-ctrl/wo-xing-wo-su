import { env } from "cloudflare:workers";

type Payload = {
  current?: Record<string, unknown>;
  answer?: unknown;
  history?: unknown[];
};

type Result = {
  connected: boolean;
  decision: "continue" | "need_clarify" | "need_human";
  message: string;
  risk_flags: string[];
  normalized_answer: string;
};

function jsonResponse(payload: Result, status = 200): Response {
  return Response.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

function modelName(): string {
  return env.DEEPSEEK_MODEL || "deepseek-chat";
}

function apiUrl(): string {
  return env.DEEPSEEK_API_URL || "https://api.deepseek.com/chat/completions";
}

function foldText(value: unknown): string {
  const text = String(value ?? "").trim();
  const table = new Map(
    [
      ["０", "0"],
      ["１", "1"],
      ["２", "2"],
      ["３", "3"],
      ["４", "4"],
      ["５", "5"],
      ["６", "6"],
      ["７", "7"],
      ["８", "8"],
      ["９", "9"],
      ["，", ","],
      ["．", "."],
      ["％", "%"],
      ["（", "("],
      ["）", ")"],
      ["－", "-"],
      ["　", " "],
      ["Ｘ", "X"],
      ["ｘ", "X"],
    ] as const,
  );
  return Array.from(text, (char) => table.get(char) ?? char).join("");
}

function extractJson(text: string): Record<string, unknown> {
  let content = text.trim();
  if (content.startsWith("```")) {
    content = content.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  }
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start >= 0 && end >= start) {
    content = content.slice(start, end + 1);
  }
  return JSON.parse(content) as Record<string, unknown>;
}

function baseResult(
  decision: Result["decision"] = "continue",
  message = "",
  riskFlags: string[] = [],
  extra: Partial<Result> = {},
): Result {
  return {
    connected: true,
    decision,
    message,
    risk_flags: riskFlags,
    normalized_answer: "",
    ...extra,
  };
}

function parseMoney(value: unknown): number | null {
  const text = foldText(value).replaceAll(",", "");
  const match = text.match(/(?:人民币|RMB|¥)?\s*(\d+(?:\.\d+)?)\s*(万)?\s*(?:元|人民币)?/i);
  if (!match) {
    return null;
  }
  let amount = Number(match[1]);
  if (match[2]) {
    amount *= 10000;
  }
  return Number.isFinite(amount) ? amount : null;
}

function parseMoneyValues(value: unknown): number[] {
  const text = foldText(value).replaceAll(",", "");
  const values: number[] = [];
  for (const match of text.matchAll(/(?:人民币|RMB|¥)?\s*(\d+(?:\.\d+)?)\s*(万)?\s*(?:元|人民币|RMB|¥)?/gi)) {
    let amount = Number(match[1]);
    if (match[2]) {
      amount *= 10000;
    }
    if (Number.isFinite(amount)) {
      values.push(amount);
    }
  }
  return values;
}

function stripDates(value: unknown): string {
  return foldText(value).replace(/(20\d{2}|19\d{2})[年.\/-]\d{1,2}[月.\/-]\d{1,2}日?/g, " ");
}

function hasDate(value: unknown): boolean {
  const text = foldText(value);
  const normalized = text.replaceAll("/", "-").replaceAll(".", "-").replaceAll("年", "-").replaceAll("月", "-").replaceAll("日", "");
  const match = normalized.match(/(19\d{2}|20\d{2})-(\d{1,2})-(\d{1,2})/);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return year >= 1900 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function isMoneyTitle(title: string): boolean {
  return ["金额", "本金", "诉讼费", "保全费"].some((token) => title.includes(token)) || title.includes("已还款");
}

function isDateTitle(title: string): boolean {
  return (title.includes("日期") || title.includes("时间")) && !isMoneyTitle(title);
}

function isIdTitle(title: string): boolean {
  return title.includes("身份证") || title.includes("身份信息");
}

function mainlandIdValid(value: string): boolean {
  const normalized = foldText(value).toUpperCase();
  if (!/^\d{17}[\dX]$/.test(normalized)) {
    return false;
  }
  const year = Number(normalized.slice(6, 10));
  const month = Number(normalized.slice(10, 12));
  const day = Number(normalized.slice(12, 14));
  if (!(year >= 1900 && year <= 2026 && month >= 1 && month <= 12 && day >= 1 && day <= 31)) {
    return false;
  }
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = "10X98765432";
  const total = weights.reduce((sum, weight, index) => sum + Number(normalized[index]) * weight, 0);
  return checks[total % 11] === normalized[17];
}

function hkIdValid(value: string): boolean {
  const normalized = foldText(value).toUpperCase().replaceAll(" ", "");
  const match = normalized.match(/^([A-Z]{1,2})(\d{6})\(?([0-9A])\)?$/);
  if (!match) {
    return false;
  }
  const letters = match[1];
  const digits = match[2];
  const check = match[3];
  const values =
    letters.length === 1
      ? [36, letters.charCodeAt(0) - 55]
      : [letters.charCodeAt(0) - 55, letters.charCodeAt(1) - 55];
  values.push(...digits.split("").map(Number));
  const weights = [9, 8, 7, 6, 5, 4, 3, 2, 1];
  const total = values.reduce((sum, value, index) => sum + value * weights[index], 0);
  const expected = (11 - (total % 11)) % 11;
  const expectedChar = expected === 10 ? "A" : String(expected);
  return expectedChar === check;
}

function twIdValid(value: string): boolean {
  const normalized = foldText(value).toUpperCase().replaceAll(" ", "");
  if (!/^[A-Z][1289]\d{8}$/.test(normalized)) {
    return false;
  }
  const codes: Record<string, number> = {
    A: 10,
    B: 11,
    C: 12,
    D: 13,
    E: 14,
    F: 15,
    G: 16,
    H: 17,
    I: 34,
    J: 18,
    K: 19,
    L: 20,
    M: 21,
    N: 22,
    O: 35,
    P: 23,
    Q: 24,
    R: 25,
    S: 26,
    T: 27,
    U: 28,
    V: 29,
    W: 32,
    X: 30,
    Y: 31,
    Z: 33,
  };
  const code = codes[normalized[0]];
  const digits = [Math.floor(code / 10), code % 10, ...normalized.slice(1).split("").map(Number)];
  const weights = [1, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1];
  return digits.reduce((sum, digit, index) => sum + digit * weights[index], 0) % 10 === 0;
}

function classifyId(value: string): [string | null, boolean] {
  const text = foldText(value).toUpperCase();
  const compact = text.replace(/[\s\-_/]/g, "");
  const candidates = compact.match(/\d{17}[\dX]|[A-Z][1289]\d{8}|[A-Z]{1,2}\d{6}\(?[0-9A]\)?/g);
  if (!candidates?.length) {
    return [null, false];
  }
  const item = candidates[0];
  if (/^\d{17}[\dX]$/.test(item)) {
    return ["中国大陆居民身份证", mainlandIdValid(item)];
  }
  if (/^[A-Z][1289]\d{8}$/.test(item)) {
    return ["台湾身份证号", twIdValid(item)];
  }
  return ["香港身份证号", hkIdValid(item)];
}

function nameSuspicious(name: string): boolean {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) {
    return true;
  }
  if (/\d|先生|女士|某|未知|不详|测试|test|xxx/i.test(trimmed)) {
    return true;
  }
  const clean = trimmed.replace(/[·•．.\-\s]/g, "");
  return !/^[\u4e00-\u9fffA-Za-z]{2,20}$/.test(clean);
}

function splitIdentityParts(value: string): string[] {
  return String(value ?? "")
    .split(/[;；、,，\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function pickNamePart(parts: string[]): string | null {
  for (const part of parts) {
    if (/[\u4e00-\u9fffA-Za-z]{2,}/.test(part) && !/^(不详|未知|暂无|不清楚|无|待补|待定)$/i.test(part)) {
      return part;
    }
  }
  return null;
}

function previousPrincipal(history: unknown[]): number | null {
  for (const item of [...history].reverse()) {
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const title = String(record.title ?? "");
      const answer = record.answer;
      if (title.includes("借款总金额") || title.includes("本金")) {
        const amount = parseMoney(answer);
        if (amount !== null) {
          return amount;
        }
      }
    }
  }
  for (const item of [...history].reverse()) {
    if (item && typeof item === "object") {
      const amount = parseMoney((item as Record<string, unknown>).answer);
      if (amount !== null) {
        return amount;
      }
    } else {
      const amount = parseMoney(item);
      if (amount !== null) {
        return amount;
      }
    }
  }
  return null;
}

function localJudge(payload: Payload): Result {
  const current = payload.current ?? {};
  const title = String(current.title ?? "");
  const kind = String(current.kind ?? "");
  const answer = foldText(payload.answer);
  const history = Array.isArray(payload.history) ? payload.history : [];
  const risks: string[] = [];

  if (kind === "choice") {
    return baseResult("continue", "选择已记录，可继续。", risks);
  }

  if (title === "请填写被告个人身份信息") {
    const parts = splitIdentityParts(answer);
    const namePart = pickNamePart(parts);
    if (!namePart) {
      return baseResult("need_clarify", "请先填写被告姓名。", ["被告姓名缺失"]);
    }
    const [region, valid] = classifyId(answer);
    if (region && valid) {
      return baseResult("continue", "被告身份信息已记录，可继续。", [...risks, `已识别为${region}`], {
        normalized_answer: namePart,
      });
    }
    return baseResult(
      "continue",
      region ? "被告姓名已记录，身份证号待核实。" : "被告姓名已记录，身份证号可后补。",
      region ? [...risks, "被告身份证号待核实"] : [...risks, "被告身份证号暂缺"],
      {
        normalized_answer: namePart,
      },
    );
  }

  if (title.includes("姓名")) {
    const names = answer
      .split(/[;；、,，\s]+/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (!names.length || names.some((name) => nameSuspicious(name))) {
      return baseResult("need_clarify", "姓名格式可疑，请核实真实姓名。", ["姓名真实性需核实"]);
    }
  }

  if (isIdTitle(title) && /[\dA-Za-z]/.test(answer)) {
    const [region, valid] = classifyId(answer);
    if (!region) {
      return baseResult("need_clarify", "请填写大陆、香港或台湾身份证号。", ["身份证号特征无法识别"]);
    }
    if (!valid) {
      return baseResult("need_clarify", `${region}格式或校验位不正确。`, ["身份证号校验未通过"], {
        normalized_answer: region,
      });
    }
    risks.push(`已识别为${region}`);
  }

  if (isDateTitle(title)) {
    if (!hasDate(answer)) {
      return baseResult("need_clarify", "日期请按年月日填写。", ["日期无法识别"]);
    }
    return baseResult("continue", "日期已识别，可继续。", risks);
  }

  if (isMoneyTitle(title)) {
    const moneyAnswer = stripDates(answer);
    const amount = parseMoney(moneyAnswer);
    if (amount === null) {
      return baseResult("need_clarify", "金额请填写阿拉伯数字。", ["金额无法识别"]);
    }
    if (title.includes("已还")) {
      if (!hasDate(answer)) {
        return baseResult("need_clarify", "已还款请同时填写金额和时间。", ["已还款时间缺失"]);
      }
      const principal = previousPrincipal(history);
      const paidTotal = parseMoneyValues(moneyAnswer).reduce((sum, value) => sum + value, 0) || amount;
      if (principal !== null && paidTotal > principal) {
        return baseResult("need_clarify", "已还金额超过本金，请确认。", ["已还金额大于借款本金"], {
          normalized_answer: `${paidTotal.toFixed(2)}元`,
        });
      }
    }
    return baseResult("continue", "金额已识别，可继续。", risks, {
      normalized_answer: `${amount.toFixed(2)}元`,
    });
  }

  if (title.includes("利息") || title.includes("利率")) {
    if (!/\d/.test(answer)) {
      return baseResult("need_clarify", "利息请填写阿拉伯数字。", ["利息数值无法识别"]);
    }
    const daily = ["日息", "日利率", "每日", "/日", "天息"].some((token) => answer.includes(token));
    const annual = ["年息", "年利率", "每年", "/年"].some((token) => answer.includes(token));
    const monthly = ["月息", "月利率", "每月", "/月"].some((token) => answer.includes(token));
    const periods = [
      ["日息", daily],
      ["月息", monthly],
      ["年息", annual],
    ].filter(([, selected]) => selected).map(([label]) => label);
    if (periods.length > 1) {
      return baseResult("need_clarify", "请只选择日息、月息或年息一种。", ["利息周期冲突"]);
    }
    if (!periods.length) {
      return baseResult("need_clarify", "请注明是日息、月息还是年息。", ["利息周期缺失"]);
    }
    return baseResult("continue", "利息周期已识别，可继续。", risks, {
      normalized_answer: periods[0],
    });
  }

  return baseResult("continue", "本地规则已通过。", risks);
}

function buildPromptResult(ruleResult: Result): Record<string, unknown> {
  return {
    connected: true,
    decision: ruleResult.decision,
    message: ruleResult.message,
    risk_flags: ruleResult.risk_flags,
    normalized_answer: ruleResult.normalized_answer,
  };
}

async function judgeWithDeepSeek(payload: Payload): Promise<Result> {
  const ruleResult = localJudge(payload);
  if (ruleResult.decision !== "continue") {
    return ruleResult;
  }

  const current = payload.current ?? {};
  const title = String(current.title ?? "");
  const answer = foldText(payload.answer);

  if (title === "请填写被告个人身份信息") {
    return ruleResult;
  }

  if (isIdTitle(title) && classifyId(answer)[1]) {
    return {
      ...ruleResult,
      message: "身份证号已通过本地校验。",
    };
  }

  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return {
      ...ruleResult,
      connected: false,
      message: "站点尚未配置 DeepSeek 密钥。",
    };
  }

  const systemPrompt =
    "你是“我行我诉”的诉讼流程判断模块，只做流程与材料完整性判断，不直接替代律师意见。" +
    "根据用户当前步骤、答案和历史上下文，判断是否可以进入下一步、是否需要补充、是否建议转人工。" +
    "只输出严格 JSON，不要输出 Markdown。字段：" +
    "decision 只能是 continue、need_clarify、need_human；" +
    "message 为 35 字以内中文短句；" +
    "risk_flags 为中文字符串数组；" +
    "normalized_answer 为对用户答案的简短归一化。" +
    "除非答案明显矛盾、缺关键身份信息、金额日期无法识别、证据来源明显不足或存在虚假风险，否则 decision 用 continue。";

  const userPrompt = JSON.stringify(
    {
      app: "我行我诉",
      case_type: "民间借贷诉讼指导",
      current: current,
      answer: payload.answer ?? "",
      history: (payload.history ?? []).slice(-20),
      local_rule_result: buildPromptResult(ruleResult),
    },
    null,
    0,
  );

  const response = await fetch(apiUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      model: modelName(),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.1,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    return {
      ...ruleResult,
      connected: false,
      message: detail.slice(0, 160) || `DeepSeek request failed with HTTP ${response.status}`,
    };
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    return {
      ...ruleResult,
      connected: false,
      message: "DeepSeek returned an empty response.",
    };
  }

  const parsed = extractJson(content);
  const result: Result = {
    connected: true,
    decision: (parsed.decision as Result["decision"]) ?? "continue",
    message: String(parsed.message ?? ""),
    risk_flags: Array.isArray(parsed.risk_flags)
      ? [
          ...ruleResult.risk_flags,
          ...parsed.risk_flags.filter((item): item is string => typeof item === "string"),
        ]
      : [...ruleResult.risk_flags],
    normalized_answer: String(parsed.normalized_answer ?? ""),
  };

  return result;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const payload = (await request.json()) as Payload;
    const result = await judgeWithDeepSeek(payload ?? {});
    return jsonResponse(result);
  } catch (error) {
    return jsonResponse(
      {
        connected: false,
        decision: "continue",
        message: error instanceof Error ? error.message.slice(0, 160) : "Failed to process judge request.",
        risk_flags: [],
        normalized_answer: "",
      },
      500,
    );
  }
}
