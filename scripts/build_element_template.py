from __future__ import annotations

import pathlib
import sys
import zipfile
from xml.etree import ElementTree as ET

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def unique_cells(row: ET.Element) -> list[ET.Element]:
    result: list[ET.Element] = []
    seen: set[int] = set()
    for cell in row.findall(f"{W}tc"):
        marker = id(cell)
        if marker not in seen:
            seen.add(marker)
            result.append(cell)
    return result


def set_paragraph_text(paragraph: ET.Element, value: str) -> None:
    texts = paragraph.findall(f".//{W}t")
    if not texts:
        run = paragraph.find(f"{W}r") or ET.SubElement(paragraph, f"{W}r")
        texts = [ET.SubElement(run, f"{W}t")]
    texts[0].text = value
    texts[0].set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    for node in texts[1:]:
        node.text = ""


def set_cell_paragraphs(cell: ET.Element, values: list[str]) -> None:
    paragraphs = cell.findall(f"{W}p")
    while len(paragraphs) < len(values):
        paragraphs.append(ET.SubElement(cell, f"{W}p"))
    for index, paragraph in enumerate(paragraphs):
        set_paragraph_text(paragraph, values[index] if index < len(values) else "")


def build(source: pathlib.Path, target: pathlib.Path) -> None:
    # Only the answer-side cells are changed. Every heading, instruction,
    # label, row, merge, width, border and paragraph position stays inherited
    # from the official form supplied by the user.
    slots: dict[int, list[str]] = {
        2: ["姓名：{{P_NAME}}", "性别：男{{P_MALE}} 女{{P_FEMALE}}", "出生日期：{{P_BIRTH_YEAR}}年{{P_BIRTH_MONTH}}月{{P_BIRTH_DAY}}日      民族：{{P_NATION}}", "工作单位：{{P_WORK}}            职务：{{P_JOB}}           联系电话：{{P_PHONE}}", "住所地（户籍所在地）：{{P_DOMICILE}}", "经常居住地：{{P_RESIDENCE}}", "证件类型：{{P_ID_TYPE}}", "证件号码：{{P_ID}}"],
        3: ["名称：{{P_ORG_NAME}}", "住所地（主要办事机构所在地）：{{P_ORG_OFFICE}}", "注册地/登记地：{{P_ORG_REGISTERED}}", "法定代表人/主要负责人：{{P_ORG_REP}}        职务：{{P_ORG_REP_JOB}}        联系电话：{{P_ORG_PHONE}}     ", "统一社会信用代码：{{P_ORG_CODE}}", "类型：有限责任公司{{P_T_LLC}} 股份有限公司{{P_T_JSC}} 上市公司{{P_T_LISTED}} 其他企业法人{{P_T_OTHER_CORP}}", "事业单位{{P_T_INSTITUTION}} 社会团体{{P_T_ASSOCIATION}} 基金会{{P_T_FOUNDATION}} 社会服务机构{{P_T_SERVICE}} ", "机关法人{{P_T_AGENCY}} 农村集体经济组织法人{{P_T_RURAL}}  城镇农村的合作经济组织法人{{P_T_COOP}} 基层群众性自治组织法人{{P_T_AUTONOMY}} ", "个人独资企业{{P_T_SOLE}} 合伙企业{{P_T_PARTNER}} 不具有法人资格的专业服务机构{{P_T_PRO_SERVICE}} ", "国有{{P_STATE}} （控股{{P_HOLDING}}参股{{P_SHARE}}）民营{{P_PRIVATE}} "],
        4: ["有{{AG_Y}}", "姓名：{{AG_NAME}}", "单位：{{AG_UNIT}}  职务：{{AG_JOB}}   联系电话：{{AG_PHONE}}", "代理权限：一般授权{{AG_GENERAL}}  特别授权{{AG_SPECIAL}}  ", "无{{AG_N}}"],
        5: ["地址：{{SERVICE_ADDRESS}}", "收件人：{{SERVICE_RECIPIENT}}", "电话：{{SERVICE_PHONE}}"],
        6: ["是{{ES_Y}}  方式：短信{{ES_SMS}}   微信{{ES_WECHAT}}        传真{{ES_FAX}}         邮箱{{ES_EMAIL}}                 其他{{ES_OTHER}}", "否{{ES_N}}"],
        7: ["姓名：{{D_NAME}}", "性别：男{{D_MALE}} 女{{D_FEMALE}}", "出生日期：{{D_BIRTH_YEAR}}年{{D_BIRTH_MONTH}}月{{D_BIRTH_DAY}}日           民族：{{D_NATION}}", "工作单位：{{D_WORK}}          职务：{{D_JOB}}            联系电话：{{D_PHONE}}", "住所地（户籍所在地）：{{D_DOMICILE}}", "经常居住地：{{D_RESIDENCE}}"],
        8: ["名称：{{D_ORG_NAME}}", "住所地（主要办事机构所在地）：{{D_ORG_OFFICE}}", "注册地/登记地：{{D_ORG_REGISTERED}}", "法定代表人/主要负责人：{{D_ORG_REP}}         职务：{{D_ORG_REP_JOB}}        联系电话：{{D_ORG_PHONE}}", "统一社会信用代码：{{D_ORG_CODE}}", "类型：有限责任公司{{D_T_LLC}} 股份有限公司{{D_T_JSC}}  上市公司{{D_T_LISTED}} 其他企业法人{{D_T_OTHER_CORP}}", "事业单位{{D_T_INSTITUTION}} 社会团体{{D_T_ASSOCIATION}} 基金会{{D_T_FOUNDATION}} 社会服务机构{{D_T_SERVICE}}", "机关法人{{D_T_AGENCY}} 农村集体经济组织法人{{D_T_RURAL}}  城镇农村的合作经济组织法人{{D_T_COOP}} 基层群众性自治组织法人{{D_T_AUTONOMY}}", "个人独资企业{{D_T_SOLE}} 合伙企业{{D_T_PARTNER}} 不具有法人资格的专业服务机构{{D_T_PRO_SERVICE}}", "国有{{D_STATE}} （控股{{D_HOLDING}}参股{{D_SHARE}}）民营{{D_PRIVATE}}"],
        9: ["姓名：{{T_NAME}}", "性别：男{{T_MALE}} 女{{T_FEMALE}}", "出生日期：{{T_BIRTH_YEAR}}年{{T_BIRTH_MONTH}}月{{T_BIRTH_DAY}}日            民族：{{T_NATION}}", "工作单位：{{T_WORK}}          职务：{{T_JOB}}            联系电话：{{T_PHONE}}", "住所地（户籍所在地）：{{T_DOMICILE}}", "经常居住地：{{T_RESIDENCE}}"],
        10: ["名称：{{T_ORG_NAME}}", "住所地（主要办事机构所在地）：{{T_ORG_OFFICE}}", "注册地/登记地：{{T_ORG_REGISTERED}}", "法定代表人/主要负责人：{{T_ORG_REP}}        职务：{{T_ORG_REP_JOB}}        联系电话：{{T_ORG_PHONE}}", "统一社会信用代码：{{T_ORG_CODE}}", "类型：有限责任公司{{T_T_LLC}}股份有限公司{{T_T_JSC}}上市公司{{T_T_LISTED}}其他企业法人{{T_T_OTHER_CORP}}", "事业单位{{T_T_INSTITUTION}}社会团体{{T_T_ASSOCIATION}}基金会{{T_T_FOUNDATION}}社会服务机构{{T_T_SERVICE}}", "机关法人{{T_T_AGENCY}}农村集体经济组织法人{{T_T_RURAL}} 城镇农村的合作经济组织法人{{T_T_COOP}}基层群众性自治组织法人{{T_T_AUTONOMY}}", "个人独资企业{{T_T_SOLE}}合伙企业{{T_T_PARTNER}}不具有法人资格的专业服务机构{{T_T_PRO_SERVICE}}", "国有{{T_STATE}} （控股{{T_HOLDING}}参股{{T_SHARE}}）民营{{T_PRIVATE}}"],
        12: ["截至{{PRINCIPAL_DATE}}止，尚欠本金{{PRINCIPAL_REMAIN}}元（人民币，下同）；"],
        13: ["截至{{INTEREST_DATE}}止，欠利息{{INTEREST_AMOUNT}}元；  计算方式：{{INTEREST_METHOD}}", "是否请求支付至实际清偿之日止：是{{INTEREST_UNTIL_Y}} 否{{INTEREST_UNTIL_N}}"],
        14: ["是{{EARLY_Y}}  提前还款（加速到期）{{ACCELERATE}}/解除合同{{TERMINATE}}", "否{{EARLY_N}}"],
        15: ["是{{GUARANTEE_CLAIM_Y}}    内容：{{GUARANTEE_CLAIM}}", "否{{GUARANTEE_CLAIM_N}}"],
        16: ["是{{COST_Y}}   明细：{{COST_DETAIL}}", "否{{COST_N}}", ""],
        17: ["{{OTHER_CLAIMS}}"], 18: ["{{TOTAL_AMOUNT}}元"], 19: ["合同约定：{{REQUEST_CONTRACT}}", "法律规定：{{REQUEST_LAW}}"],
        21: ["有{{JURISDICTION_Y}}  合同条款及内容：{{JURISDICTION_DETAIL}}", "无{{JURISDICTION_N}}"],
        22: ["已经诉前保全：是{{PRE_Y}}     保全法院：{{PRE_COURT}}     保全时间：{{PRE_DATE}}", "否{{PRE_N}}", "申请诉讼保全：是{{LITIGATION_PRESERVATION_Y}}", "    否{{LITIGATION_PRESERVATION_N}}"],
        24: ["{{CONTRACT_DETAIL}}"], 25: ["贷款人：{{LENDER}}", "借款人：{{BORROWER}}"], 26: ["约定：{{AGREED_AMOUNT}}元", "实际提供：{{ACTUAL_AMOUNT}}元"],
        27: ["是否到期： 是{{DUE_Y}} 否{{DUE_N}}", "约定期限：{{LOAN_START}}起至{{LOAN_END}}止"],
        28: ["利率{{RATE_SELECTED}}   {{RATE_VALUE}}%/年（季/月）（合同条款：第{{RATE_CLAUSE}}   条） "], 29: [" {{PROVIDE_DATE}}，{{ACTUAL_AMOUNT}}元"],
        30: ["等额本息{{REPAY_EQUAL_PI}}", "等额本金{{REPAY_EQUAL_P}}", "到期一次性还本付息{{REPAY_LUMP_PI}}", "按月计息、到期一次性还本{{REPAY_MONTH}}", "按季计息、到期一次性还本{{REPAY_QUARTER}}", "按年计息、到期一次性还本{{REPAY_YEAR}}", "其他{{REPAY_OTHER_CHECK}}{{REPAY_OTHER}}"],
        31: ["已还本金：{{PAID_PRINCIPAL}}元", "已还利息：{{PAID_INTEREST}}元，还息至{{PAID_INTEREST_YEAR}}年/{{PAID_INTEREST_MONTH}}月/{{PAID_INTEREST_DAY}}日"],
        32: ["是{{OVERDUE_Y}}  逾期时间：{{OVERDUE_DATE}}至今已逾期", "否{{OVERDUE_N}}"],
        33: ["是{{SECURITY_CONTRACT_Y}}     签订时间：{{SECURITY_DATE}}", "否{{SECURITY_CONTRACT_N}}"], 34: ["担保人：{{GUARANTOR}}", "担保物：{{SECURITY_OBJECT}}"],
        35: ["是{{MAX_SECURITY_Y}}", "否{{MAX_SECURITY_N}}", "担保债权的确定时间：{{MAX_SECURITY_DATE}}", "担保额度：{{MAX_SECURITY_AMOUNT}}"],
        36: ["是{{REGISTRATION_Y}}  正式登记{{FORMAL_REG}}", "       预告登记{{NOTICE_REG}}", "否{{REGISTRATION_N}}"],
        37: ["是{{GUARANTEE_CONTRACT_Y}}  签订时间：{{GUARANTEE_DATE}}    保证人：{{GUARANTOR}}", "      主要内容：{{GUARANTEE_CONTENT}}", "否{{GUARANTEE_CONTRACT_N}}"],
        38: ["一般保证{{GENERAL_GUARANTEE}}", "连带责任保证{{JOINT_GUARANTEE}}"], 39: ["是{{OTHER_SECURITY_Y}}    形式：{{OTHER_SECURITY_TYPE}}      签订时间：{{OTHER_SECURITY_DATE}}", "否{{OTHER_SECURITY_N}}"],
        40: ["{{OTHER_FACTS}}"], 41: ["{{EVIDENCE_LIST}}"],
    }
    target.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(source, "r") as src:
        document = ET.fromstring(src.read("word/document.xml"))
        table = document.find(f".//{W}tbl")
        if table is None:
            raise RuntimeError("模板中未找到表格")
        rows = table.findall(f"{W}tr")
        for row_index, paragraphs in slots.items():
            cells = unique_cells(rows[row_index])
            set_cell_paragraphs(cells[-1], paragraphs)
        body = document.find(f"{W}body")
        body_paragraphs = body.findall(f"{W}p") if body is not None else []
        if len(body_paragraphs) >= 5:
            set_paragraph_text(body_paragraphs[3], "                     具状人（签字、盖章）：{{PARTY_SIGN}}")
            set_paragraph_text(body_paragraphs[4], "                       日期：{{FILING_YEAR}}年{{FILING_MONTH}}月{{FILING_DAY}}日")
        xml = ET.tostring(document, encoding="utf-8", xml_declaration=True)
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as out:
            for item in src.infolist():
                out.writestr(item, xml if item.filename == "word/document.xml" else src.read(item.filename))


if __name__ == "__main__":
    build(pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]))
