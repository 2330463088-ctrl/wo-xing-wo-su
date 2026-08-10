import { AlignmentType, Document, ImageRun, Packer, Paragraph, TextRun, convertInchesToTwip } from "docx";

type Payload = {
  text?: string;
  filename?: string;
  pages?: string[];
};

const BODY_FONT = "仿宋_GB2312";
const TITLE_FONT = "方正小标宋简体";
const PAGE_WIDTH = 816;
const PAGE_HEIGHT = 1056;

function normalizeText(text: string): string {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  })[char] || char);
}

function decodeImageDataUrl(dataUrl: string): Buffer {
  const raw = String(dataUrl || "");
  const base64 = raw.includes(",") ? raw.split(",").pop() || "" : raw;
  return Buffer.from(base64, "base64");
}

function cleanLine(line: string): string {
  return normalizeText(line)
    .replace(/^#{1,6}\s*/g, "")
    .replace(/^\s*[-*+]\s+/g, "")
    .replace(/^>\s?/g, "");
}

function paragraphForLine(line: string, index: number): Paragraph {
  const text = cleanLine(line);
  if (!text) {
    return new Paragraph({ text: "", spacing: { after: 120 } });
  }
  if (index === 0 && /民事起诉状/.test(text)) {
    return new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 260 },
      children: [new TextRun({ text, font: TITLE_FONT, size: 52, bold: false })],
    });
  }
  if (text === "诉讼请求：" || text === "事实与理由：" || text === "证据和证据来源：" || text === "证据清单：" || text === "附：证据目录") {
    return new Paragraph({
      alignment: AlignmentType.LEFT,
      spacing: { before: 120, after: 100 },
      children: [new TextRun({ text, font: BODY_FONT, size: 32, bold: true })],
    });
  }
  if (text === "此致") {
    return new Paragraph({
      alignment: AlignmentType.LEFT,
      spacing: { before: 160, after: 60 },
      children: [new TextRun({ text, font: BODY_FONT, size: 32 })],
    });
  }
  if (/^(具状人：|20\d{2}年\d{1,2}月\d{1,2}日|19\d{2}年\d{1,2}月\d{1,2}日|XXXX年XX月XX日)$/.test(text)) {
    return new Paragraph({
      alignment: AlignmentType.RIGHT,
      spacing: { after: 80 },
      children: [new TextRun({ text, font: BODY_FONT, size: 32 })],
    });
  }
  if (/^(一|二|三|四|五|六|七|八|九|十)+、/.test(text) || /^\d+[、.．]/.test(text)) {
    return new Paragraph({
      alignment: AlignmentType.JUSTIFIED,
      indent: { left: 720, hanging: 360 },
      spacing: { line: 600, after: 0 },
      children: [new TextRun({ text, font: BODY_FONT, size: 32 })],
    });
  }
  if (/^(原告|被告|法定代表人|委托诉讼代理人|住所地|住址|联系电话|身份证号码|统一社会信用代码|具状人|法院)/.test(text)) {
    return new Paragraph({
      alignment: AlignmentType.JUSTIFIED,
      spacing: { line: 600, after: 0 },
      children: [new TextRun({ text, font: BODY_FONT, size: 32 })],
    });
  }
  return new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    indent: { firstLine: 640 },
    spacing: { line: 600, after: 0 },
      children: [new TextRun({ text, font: BODY_FONT, size: 32 })],
  });
}

function buildImageDocument(pages: string[]): Document {
  const children = pages.map((page, index) => {
    const imageBuffer = decodeImageDataUrl(page);
    const imageRun = new ImageRun({
      data: imageBuffer,
      type: "png",
      transformation: {
        width: PAGE_WIDTH,
        height: PAGE_HEIGHT,
      },
    });
    return new Paragraph({
      pageBreakBefore: index > 0,
      spacing: { before: 0, after: 0 },
      children: [imageRun],
    });
  });

  return new Document({
    styles: {
      default: {
        document: {
          run: {
            font: {
              ascii: BODY_FONT,
              hAnsi: BODY_FONT,
              eastAsia: BODY_FONT,
              cs: BODY_FONT,
            },
            size: 24,
            sizeComplexScript: 24,
            language: {
              value: "zh-CN",
              eastAsia: "zh-CN",
            },
          },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: {
              width: convertInchesToTwip(8.5),
              height: convertInchesToTwip(11),
            },
            margin: {
              top: 0,
              right: 0,
              bottom: 0,
              left: 0,
            },
          },
        },
        children,
      },
    ],
  });
}

function buildDocument(text: string): Document {
  const lines = normalizeText(text).split("\n");
  const paragraphs = lines.map((line, index) => paragraphForLine(line, index));
  return new Document({
    styles: {
      default: {
        document: {
          run: {
            font: BODY_FONT,
            size: 32,
            sizeComplexScript: 32,
            language: {
              value: "zh-CN",
              eastAsia: "zh-CN",
            },
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

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Cache-Control": "no-store",
  };
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as Payload;
    const text = normalizeText(payload.text || "");
    const pages = Array.isArray(payload.pages)
      ? payload.pages.map((page) => String(page || "")).filter(Boolean)
      : [];
    if (!text && pages.length === 0) {
      return Response.json(
        { error: "missing text" },
        { status: 400, headers: corsHeaders() },
      );
    }
    const doc = pages.length > 0 ? buildImageDocument(pages) : buildDocument(text);
    const buffer = await Packer.toBuffer(doc);
    const filename = (payload.filename || "民事起诉状.docx").replace(/[\\/:*?"<>|]+/g, "_");
    return new Response(buffer, {
      status: 200,
      headers: {
        ...corsHeaders(),
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Content-Length": String(buffer.byteLength),
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: corsHeaders() },
    );
  }
}
