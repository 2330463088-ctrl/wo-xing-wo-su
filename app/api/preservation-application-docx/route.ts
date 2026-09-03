/**
 * 诉前财产保全申请书生成
 * 基于 tokens 用 docx 库生成规范格式的 docx
 */
import {
  Document,
  Paragraph,
  TextRun,
  AlignmentType,
  convertInchesToTwip,
  Packer,
} from "docx";

type Payload = {
  tokens?: Record<string, unknown>;
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

function getToken(
  tokens: Record<string, unknown>,
  key: string,
  fallback = ""
): string {
  const val = tokens[key];
  if (val === undefined || val === null) return fallback;
  return String(val);
}

function titleParagraph(text: string): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 200, after: 400 },
    children: [
      new TextRun({
        text,
        font: TITLE_FONT,
        size: 44, // 二号字
        bold: true,
      }),
    ],
  });
}

function bodyParagraph(
  text: string,
  opts: { indent?: boolean; bold?: boolean; after?: number } = {}
): Paragraph {
  const { indent = false, bold = false, after = 200 } = opts;
  return new Paragraph({
    indent: indent
      ? { firstLine: 640 } // 首行缩进 2 字符
      : undefined,
    spacing: { after },
    children: [
      new TextRun({
        text,
        font: BODY_FONT,
        size: 32, // 三号字
        bold,
      }),
    ],
  });
}

function buildDocument(tokens: Record<string, unknown>): Document {
  const applicantInfo = getToken(tokens, "APPLICANT_INFO");
  const respondentInfo = getToken(tokens, "RESPONDENT_INFO");
  const amount = getToken(tokens, "PRESERVATION_AMOUNT");
  const court = getToken(tokens, "COURT_NAME");
  const applicantName = getToken(tokens, "APPLICANT_NAME");
  const year = getToken(tokens, "YEAR");
  const month = getToken(tokens, "MONTH");
  const day = getToken(tokens, "DAY");

  const children: Paragraph[] = [];

  // 标题
  children.push(titleParagraph("诉前财产保全申请书"));

  // 申请人
  children.push(
    bodyParagraph(`申请人：${applicantInfo || "待补充"}`, {
      after: 120,
    })
  );

  // 被申请人
  children.push(
    bodyParagraph(`被申请人：${respondentInfo || "待补充"}`, {
      after: 400,
    })
  );

  // 请求事项
  children.push(bodyParagraph("请求事项：", { bold: true, after: 120 }));
  children.push(
    bodyParagraph(
      `请求依法冻结被申请人银行存款${amount || ""}元人民币，或查封、扣押其同等价值的财产。`,
      { indent: true, after: 400 }
    )
  );

  // 事实和理由
  children.push(bodyParagraph("事实和理由：", { bold: true, after: 120 }));
  children.push(
    bodyParagraph(
      `申请人与被申请人因民间借贷纠纷一案，申请人拟向${court || "人民法院"}提起诉讼。为防止被申请人转移财产，保证生效裁判的顺利执行，保护申请人的合法权益，根据《中华人民共和国民事诉讼法》的相关规定，现依法申请诉前财产保全。如保全不当，申请人自愿承担相应的法律责任。请批准。`,
      { indent: true, after: 400 }
    )
  );

  // 此致
  children.push(bodyParagraph("此致", { after: 120 }));
  children.push(bodyParagraph(court || "人民法院", { after: 600 }));

  // 落款
  children.push(
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      spacing: { after: 200 },
      children: [
        new TextRun({
          text: `申请人：${applicantName || ""}`,
          font: BODY_FONT,
          size: 32,
        }),
      ],
    })
  );

  children.push(
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      spacing: { after: 200 },
      children: [
        new TextRun({
          text: `${year}年${month}月${day}日`,
          font: BODY_FONT,
          size: 32,
        }),
      ],
    })
  );

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
    const tokens = payload?.tokens || {};

    const doc = buildDocument(tokens);
    const buffer = await Packer.toBuffer(doc);

    const filename = (payload.filename || "诉前财产保全申请书.docx").replace(
      /[\\/:*?"<>|]+/g,
      "_"
    );

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
