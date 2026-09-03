/**
 * 要素式起诉状生成
 * 支持两种模式：
 * 1. text 模式：前端传纯文本，直接转 docx
 * 2. tokens 模式：前端传 tokens 对象，后端按要素式格式组装
 */
import {
  Document,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  VerticalAlign,
  convertInchesToTwip,
  Packer,
} from "docx";

type Payload = {
  text?: string;
  tokens?: Record<string, unknown>;
  omit_rows?: number[];
  filename?: string;
};

const BODY_FONT = "仿宋_GB2312";
const TITLE_FONT = "方正小标宋简体";

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Cache-Control": "no-store",
  };
}

function normalizeText(text: string): string {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function titleParagraph(text: string): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 100, after: 200 },
    children: [
      new TextRun({
        text,
        font: TITLE_FONT,
        size: 44,
        bold: true,
      }),
    ],
  });
}

function subtitleParagraph(text: string): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 300 },
    children: [
      new TextRun({
        text,
        font: BODY_FONT,
        size: 28,
      }),
    ],
  });
}

function sectionTitle(text: string): Paragraph {
  return new Paragraph({
    spacing: { before: 200, after: 100 },
    children: [
      new TextRun({
        text,
        font: BODY_FONT,
        size: 32,
        bold: true,
      }),
    ],
  });
}

function bodyParagraph(text: string, indent = true): Paragraph {
  return new Paragraph({
    indent: indent ? { firstLine: 640 } : undefined,
    spacing: { after: 120 },
    children: [
      new TextRun({
        text: text || "",
        font: BODY_FONT,
        size: 32,
      }),
    ],
  });
}

function signatureParagraph(text: string, right = true): Paragraph {
  return new Paragraph({
    alignment: right ? AlignmentType.RIGHT : AlignmentType.LEFT,
    spacing: { before: 200, after: 100 },
    children: [
      new TextRun({
        text,
        font: BODY_FONT,
        size: 32,
      }),
    ],
  });
}

// ========== 纯文本模式 ==========
function buildFromText(rawText: string): Document {
  const text = normalizeText(rawText);
  const lines = text.split("\n");

  const paragraphs: Paragraph[] = [];
  let isFirstLine = true;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      paragraphs.push(new Paragraph({ text: "", spacing: { after: 120 } }));
      continue;
    }

    // 第一行一般是标题
    if (isFirstLine && trimmed.length < 20) {
      paragraphs.push(titleParagraph(trimmed));
      isFirstLine = false;
      continue;
    }
    isFirstLine = false;

    // 判断是否为小标题
    const isSectionTitle =
      (trimmed.length <= 12 &&
        /^(当事人|诉讼请求|事实|理由|证据|此致|附|具状人|原告|被告|第三人|一、|二、|三、|四、|五、)/.test(
          trimmed
        )) ||
      trimmed.endsWith("：") ||
      trimmed.endsWith(":");

    if (isSectionTitle) {
      paragraphs.push(sectionTitle(trimmed.replace(/[：:]$/, "")));
    } else {
      paragraphs.push(bodyParagraph(trimmed));
    }
  }

  return new Document({
    styles: {
      default: {
        document: {
          run: {
            font: BODY_FONT,
            size: 32,
            language: { value: "zh-CN", eastAsia: "zh-CN" },
          },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: {
              width: convertInchesToTwip(8.27),
              height: convertInchesToTwip(11.69),
            },
            margin: {
              top: convertInchesToTwip(1.22),
              right: convertInchesToTwip(1.02),
              bottom: convertInchesToTwip(1.02),
              left: convertInchesToTwip(1.26),
            },
          },
        },
        children: paragraphs,
      },
    ],
  });
}

// ========== Tokens 模式（要素式表格） ==========
const ELEMENT_ROW_LABELS = [
  "案号",
  "案由",
  "当事人信息",
  "原告姓名/名称",
  "原告身份证号/统一社会信用代码",
  "原告住址/住所地",
  "原告法定代表人",
  "被告姓名/名称",
  "被告身份证号/统一社会信用代码",
  "被告住址/住所地",
  "被告法定代表人",
  "诉讼请求",
  "1. 返还本金",
  "2. 支付利息/逾期利息",
  "3. 承担诉讼费",
  "4. 承担保全费",
  "5. 承担保函费",
  "6. 承担律师费",
  "7. 其他请求",
  "计算方式与依据",
  "借款事实",
  "约定管辖",
  "诉讼保全情况",
  "事实和理由",
  "借款时间",
  "借款金额",
  "借款用途",
  "利息约定",
  "还款情况",
  "逾期情况",
  "催收情况",
  "担保情况",
  "证据情况",
  "证据清单",
  "法律依据",
  "其他事实",
  "补充说明",
  "争议焦点",
  "此致法院",
];

function getToken(
  tokens: Record<string, unknown>,
  key: string,
  fallback = ""
): string {
  const val = tokens[key];
  if (val === undefined || val === null) return fallback;
  return String(val);
}

function buildFromTokens(
  tokens: Record<string, unknown>,
  omitRows: number[] = []
): Document {
  const omitSet = new Set(omitRows);

  const children: Paragraph[] = [];

  // 标题
  children.push(titleParagraph("民事起诉状"));
  children.push(subtitleParagraph("（民间借贷纠纷要素式）"));

  // 分组生成表格化内容
  const sections = [
    {
      title: "一、当事人信息",
      rows: [2, 3, 4, 5, 6, 7, 8, 9, 10],
    },
    {
      title: "二、诉讼请求和依据",
      rows: [11, 12, 13, 14, 15, 16, 17, 18, 19],
    },
    {
      title: "三、借款事实",
      rows: [20, 24, 25, 26, 27, 28, 29, 30, 31],
    },
    {
      title: "四、约定管辖和诉讼保全",
      rows: [21, 22],
    },
    {
      title: "五、事实和理由",
      rows: [23, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41],
    },
  ];

  // 用段落形式输出（简单可靠，不需要复杂表格排版）
  for (const section of sections) {
    children.push(sectionTitle(section.title));

    for (const rowIdx of section.rows) {
      if (omitSet.has(rowIdx)) continue;

      const label = ELEMENT_ROW_LABELS[rowIdx] || `要素${rowIdx}`;
      const tokenKey = `ROW_${rowIdx}`;
      const value = getToken(tokens, tokenKey, "").trim();

      // 找更匹配的 token key（从 tokens 里猜）
      let finalValue = value;
      if (!finalValue) {
        // 尝试匹配常见命名
        for (const [k, v] of Object.entries(tokens)) {
          const vStr = String(v || "");
          if (!vStr.trim()) continue;
          const labelKey = label.replace(/[、\s]/g, "");
          const kKey = k.replace(/[_]/g, "").toLowerCase();
          if (
            k.toLowerCase().includes(labelKey.toLowerCase()) ||
            labelKey.toLowerCase().includes(kKey)
          ) {
            finalValue = vStr;
            break;
          }
        }
      }

      if (finalValue.trim()) {
        children.push(
          new Paragraph({
            spacing: { after: 100 },
            children: [
              new TextRun({
                text: `${label}：`,
                font: BODY_FONT,
                size: 32,
                bold: true,
              }),
              new TextRun({
                text: finalValue,
                font: BODY_FONT,
                size: 32,
              }),
            ],
          })
        );
      }
    }
  }

  // 落款
  const court = getToken(tokens, "COURT") || getToken(tokens, "court") || "";
  const plaintiffName =
    getToken(tokens, "P_NAME") ||
    getToken(tokens, "P_ORG_NAME") ||
    getToken(tokens, "plaintiff") ||
    "";
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1);
  const day = String(now.getDate());

  children.push(new Paragraph({ text: "", spacing: { before: 400, after: 200 } }));
  children.push(signatureParagraph("此致", false));
  children.push(signatureParagraph(court || "人民法院", false));
  children.push(new Paragraph({ text: "", spacing: { after: 400 } }));
  children.push(signatureParagraph(`具状人（签字、盖章）：${plaintiffName}`));
  children.push(signatureParagraph(`${year}年${month}月${day}日`));

  return new Document({
    styles: {
      default: {
        document: {
          run: {
            font: BODY_FONT,
            size: 32,
            language: { value: "zh-CN", eastAsia: "zh-CN" },
          },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: {
              width: convertInchesToTwip(8.27),
              height: convertInchesToTwip(11.69),
            },
            margin: {
              top: convertInchesToTwip(1.22),
              right: convertInchesToTwip(1.02),
              bottom: convertInchesToTwip(1.02),
              left: convertInchesToTwip(1.26),
            },
          },
        },
        children,
      },
    ],
  });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json().catch(() => null)) as Payload;
    const text = payload?.text || "";
    const tokens = payload?.tokens || {};
    const omitRows = payload?.omit_rows || [];

    let doc: Document;

    if (text && text.trim()) {
      // 优先使用 text 模式（前端已经拼好文本）
      doc = buildFromText(text);
    } else if (tokens && Object.keys(tokens).length > 0) {
      // tokens 模式（要素式）
      doc = buildFromTokens(tokens, omitRows);
    } else {
      return Response.json(
        { error: "missing text or tokens" },
        { status: 400, headers: corsHeaders() }
      );
    }

    const buffer = await Packer.toBuffer(doc);
    const filename = (
      payload.filename || "要素式民事起诉状.docx"
    ).replace(/[\\/:*?"<>|]+/g, "_");

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        ...corsHeaders(),
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Content-Length": String(buffer.byteLength),
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: corsHeaders() }
    );
  }
}
