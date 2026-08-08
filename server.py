from __future__ import annotations

import json
import mimetypes
import os
import pathlib
import re
import ssl
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


ROOT = pathlib.Path(__file__).resolve().parent
PUBLIC = ROOT / "public"


def _load_env_file(path: pathlib.Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not key or key in os.environ:
            continue
        if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
            value = value[1:-1]
        os.environ[key] = value


_load_env_file(ROOT / ".env")
_load_env_file(ROOT / ".env.local")

MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-chat")
API_URL = os.environ.get("DEEPSEEK_API_URL", "https://api.deepseek.com/chat/completions")


def _json_response(handler: BaseHTTPRequestHandler, status: int, payload: dict) -> None:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(data)))
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type, Accept")
    handler.send_header("Access-Control-Max-Age", "86400")
    handler.end_headers()
    handler.wfile.write(data)


def _extract_json(text: str) -> dict:
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:].strip()
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end >= start:
        text = text[start : end + 1]
    return json.loads(text)


def _base_result(decision: str = "continue", message: str = "", risk_flags: list[str] | None = None, **extra) -> dict:
    return {
        "connected": True,
        "decision": decision,
        "message": message,
        "risk_flags": risk_flags or [],
        **extra,
    }


def _fold_text(value: object) -> str:
    text = str(value or "").strip()
    table = str.maketrans("０１２３４５６７８９，．％（）－　Ｘｘ", "0123456789,.%()- XX")
    return text.translate(table)


def _parse_money(value: object) -> float | None:
    text = _fold_text(value).replace(",", "")
    match = re.search(r"(?:人民币|RMB|¥)?\s*(\d+(?:\.\d+)?)\s*(万)?\s*(?:元|人民币)?", text, re.I)
    if not match:
        return None
    amount = float(match.group(1))
    if match.group(2):
        amount *= 10000
    return amount


def _parse_money_values(value: object) -> list[float]:
    text = _fold_text(value).replace(",", "")
    values: list[float] = []
    for match in re.finditer(r"(?:人民币|RMB|¥)?\s*(\d+(?:\.\d+)?)\s*(万)?\s*(?:元|人民币|RMB|¥)?", text, re.I):
        amount = float(match.group(1))
        if match.group(2):
            amount *= 10000
        values.append(amount)
    return values


def _strip_dates(value: object) -> str:
    return re.sub(r"(20\d{2}|19\d{2})[年.\/-]\d{1,2}[月.\/-]\d{1,2}日?", " ", _fold_text(value))


def _has_date(value: object) -> bool:
    text = _fold_text(value)
    normalized = text.replace("/", "-").replace(".", "-").replace("年", "-").replace("月", "-").replace("日", "")
    match = re.search(r"(19\d{2}|20\d{2})-(\d{1,2})-(\d{1,2})", normalized)
    if not match:
        return False
    year, month, day = (int(part) for part in match.groups())
    return 1900 <= year <= 2100 and 1 <= month <= 12 and 1 <= day <= 31


def _is_money_title(title: str) -> bool:
    return any(token in title for token in ("金额", "本金", "诉讼费", "保全费")) or "已还款" in title


def _is_date_title(title: str) -> bool:
    return any(token in title for token in ("日期", "时间")) and not _is_money_title(title)


def _is_id_title(title: str) -> bool:
    return any(token in title for token in ("身份证", "身份信息"))


def _mainland_id_valid(value: str) -> bool:
    value = _fold_text(value).upper()
    if not re.fullmatch(r"\d{17}[\dX]", value):
        return False
    try:
        year, month, day = int(value[6:10]), int(value[10:12]), int(value[12:14])
        if not (1900 <= year <= 2026 and 1 <= month <= 12 and 1 <= day <= 31):
            return False
    except ValueError:
        return False
    weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
    checks = "10X98765432"
    total = sum(int(value[i]) * weights[i] for i in range(17))
    return checks[total % 11] == value[-1]


def _hk_id_valid(value: str) -> bool:
    value = _fold_text(value).upper().replace(" ", "")
    match = re.fullmatch(r"([A-Z]{1,2})(\d{6})\(?([0-9A])\)?", value)
    if not match:
        return False
    letters, digits, check = match.groups()
    values = [36, ord(letters) - 55] if len(letters) == 1 else [ord(letters[0]) - 55, ord(letters[1]) - 55]
    values += [int(n) for n in digits]
    weights = list(range(9, 1, -1))
    total = sum(v * w for v, w in zip(values, weights))
    expected = (11 - total % 11) % 11
    expected_char = "A" if expected == 10 else str(expected)
    return expected_char == check


def _tw_id_valid(value: str) -> bool:
    value = _fold_text(value).upper().replace(" ", "")
    if not re.fullmatch(r"[A-Z][1289]\d{8}", value):
        return False
    codes = {
        "A": 10, "B": 11, "C": 12, "D": 13, "E": 14, "F": 15, "G": 16, "H": 17, "I": 34,
        "J": 18, "K": 19, "L": 20, "M": 21, "N": 22, "O": 35, "P": 23, "Q": 24, "R": 25,
        "S": 26, "T": 27, "U": 28, "V": 29, "W": 32, "X": 30, "Y": 31, "Z": 33,
    }
    code = codes[value[0]]
    digits = [code // 10, code % 10] + [int(n) for n in value[1:]]
    weights = [1, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1]
    return sum(d * w for d, w in zip(digits, weights)) % 10 == 0


def _classify_id(value: str) -> tuple[str | None, bool]:
    text = _fold_text(value).upper()
    compact = re.sub(r"[\s\-_/]", "", text)
    candidates = re.findall(r"\d{17}[\dX]|[A-Z][1289]\d{8}|[A-Z]{1,2}\d{6}\(?[0-9A]\)?", compact)
    if not candidates:
        return None, False
    item = candidates[0]
    if re.fullmatch(r"\d{17}[\dX]", item):
        return "中国大陆居民身份证", _mainland_id_valid(item)
    if re.fullmatch(r"[A-Z][1289]\d{8}", item):
        return "台湾身份证号", _tw_id_valid(item)
    return "香港身份证号", _hk_id_valid(item)


def _name_suspicious(name: str) -> bool:
    name = str(name or "").strip()
    if not name:
        return True
    if re.search(r"\d|先生|女士|某|未知|不详|测试|test|xxx", name, re.I):
        return True
    clean = re.sub(r"[·•．.\-\s]", "", name)
    return not re.fullmatch(r"[\u4e00-\u9fffA-Za-z]{2,20}", clean)


def _split_identity_parts(value: object) -> list[str]:
    return [part.strip() for part in re.split(r"[;；、,，\n]+", str(value or "")) if part.strip()]


def _pick_name_part(parts: list[str]) -> str | None:
    for part in parts:
        if re.search(r"[\u4e00-\u9fffA-Za-z]{2,}", part) and not re.fullmatch(r"(不详|未知|暂无|不清楚|无|待补|待定)", part, re.I):
            return part
    return None


def _previous_principal(history: list) -> float | None:
    for item in reversed(history or []):
        if isinstance(item, dict):
            title = str(item.get("title", ""))
            answer = item.get("answer", "")
            if "借款总金额" in title or "本金" in title:
                amount = _parse_money(answer)
                if amount is not None:
                    return amount
    for item in reversed(history or []):
        amount = _parse_money(item.get("answer") if isinstance(item, dict) else item)
        if amount is not None:
            return amount
    return None


def local_judge(payload: dict) -> dict:
    current = payload.get("current") or {}
    title = str(current.get("title", ""))
    kind = str(current.get("kind", ""))
    answer = _fold_text(payload.get("answer", ""))
    history = payload.get("history") or []
    risks: list[str] = []

    if kind == "choice":
        return _base_result("continue", "选择已记录，可继续。", risks)

    if title == "请填写被告个人身份信息":
        parts = _split_identity_parts(answer)
        name_part = _pick_name_part(parts)
        if not name_part:
            return _base_result("need_clarify", "请先填写被告姓名。", ["被告姓名缺失"])
        region, valid = _classify_id(answer)
        if region and valid:
            return _base_result("continue", "被告身份信息已记录，可继续。", [*risks, f"已识别为{region}"], normalized_answer=name_part)
        return _base_result(
            "continue",
            "被告姓名已记录，身份证号可后补。" if not region else "被告姓名已记录，身份证号待核实。",
            [*risks, "被告身份证号暂缺" if not region else "被告身份证号待核实"],
            normalized_answer=name_part,
        )

    if "姓名" in title:
        names = [part.strip() for part in re.split(r"[;；、,，\s]+", answer) if part.strip()]
        if not names or any(_name_suspicious(name) for name in names):
            return _base_result("need_clarify", "姓名格式可疑，请核实真实姓名。", ["姓名真实性需核实"])

    if _is_id_title(title) and re.search(r"\d|[A-Za-z]", answer):
        region, valid = _classify_id(answer)
        if not region:
            return _base_result("need_clarify", "请填写大陆、香港或台湾身份证号。", ["身份证号特征无法识别"])
        if not valid:
            return _base_result("need_clarify", f"{region}格式或校验位不正确。", ["身份证号校验未通过"], normalized_answer=region)
        risks.append(f"已识别为{region}")

    if _is_date_title(title):
        if not _has_date(answer):
            return _base_result("need_clarify", "日期请按年月日填写。", ["日期无法识别"])
        return _base_result("continue", "日期已识别，可继续。", risks)

    if _is_money_title(title):
        money_answer = _strip_dates(answer)
        amount = _parse_money(money_answer)
        if amount is None:
            return _base_result("need_clarify", "金额请填写阿拉伯数字。", ["金额无法识别"])
        if "已还" in title:
            if not _has_date(answer):
                return _base_result("need_clarify", "已还款请同时填写金额和时间。", ["已还款时间缺失"])
            principal = _previous_principal(history)
            paid_total = sum(_parse_money_values(money_answer)) or amount
            if principal is not None and paid_total > principal:
                return _base_result("need_clarify", "已还金额超过本金，请确认。", ["已还金额大于借款本金"], normalized_answer=f"{paid_total:.2f}元")
        return _base_result("continue", "金额已识别，可继续。", risks, normalized_answer=f"{amount:.2f}元")

    if "利息" in title or "利率" in title:
        if not re.search(r"\d", answer):
            return _base_result("need_clarify", "利息请填写阿拉伯数字。", ["利息数值无法识别"])
        daily = any(token in answer for token in ("日息", "日利率", "每日", "/日", "天息"))
        annual = any(token in answer for token in ("年息", "年利率", "每年", "/年"))
        monthly = any(token in answer for token in ("月息", "月利率", "每月", "/月"))
        periods = [label for label, selected in (("日息", daily), ("月息", monthly), ("年息", annual)) if selected]
        if len(periods) > 1:
            return _base_result("need_clarify", "请只选择日息、月息或年息一种。", ["利息周期冲突"])
        if not periods:
            return _base_result("need_clarify", "请注明是日息、月息还是年息。", ["利息周期缺失"])
        return _base_result("continue", "利息周期已识别，可继续。", risks, normalized_answer=periods[0])

    return _base_result("continue", "本地规则已通过。", risks)


def judge_with_deepseek(payload: dict) -> dict:
    rule_result = local_judge(payload)
    if rule_result["decision"] != "continue":
        return rule_result
    current = payload.get("current") or {}
    title = str(current.get("title", ""))
    answer = _fold_text(payload.get("answer", ""))

    if title == "请填写被告个人身份信息":
        return rule_result

    if _is_id_title(title) and _classify_id(answer)[1]:
        rule_result["message"] = "身份证号已通过本地校验。"
        return rule_result

    api_key = os.environ.get("DEEPSEEK_API_KEY")
    if not api_key:
        rule_result["connected"] = False
        rule_result["message"] = "DeepSeek API key is not configured on the local server."
        return rule_result

    system_prompt = (
        "你是“我行我诉”的诉讼流程判断模块，只做流程与材料完整性判断，不直接替代律师意见。"
        "根据用户当前步骤、答案和历史上下文，判断是否可以进入下一步、是否需要补充、是否建议转人工。"
        "只输出严格 JSON，不要输出 Markdown。字段："
        "decision 只能是 continue、need_clarify、need_human；"
        "message 为 35 字以内中文短句；"
        "risk_flags 为中文字符串数组；"
        "normalized_answer 为对用户答案的简短归一化。"
        "除非答案明显矛盾、缺关键身份信息、金额日期无法识别、证据来源明显不足或存在虚假风险，否则 decision 用 continue。"
    )
    user_prompt = json.dumps(
        {
            "app": "我行我诉",
            "case_type": "民间借贷诉讼指导",
            "current": payload.get("current", {}),
            "answer": payload.get("answer", ""),
            "history": payload.get("history", [])[-20:],
            "local_rule_result": rule_result,
        },
        ensure_ascii=False,
    )
    body = json.dumps(
        {
            "model": MODEL,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": 0.1,
            "response_format": {"type": "json_object"},
        },
        ensure_ascii=False,
    ).encode("utf-8")

    request = urllib.request.Request(
        API_URL,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json; charset=utf-8",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read().decode("utf-8")
    except (urllib.error.URLError, ssl.SSLError) as exc:
        reason = getattr(exc, "reason", exc)
        message = str(reason)
        if "certificate verify failed" not in message and "self-signed certificate" not in message:
            raise
        print("DeepSeek TLS verification failed, retrying without certificate checks.")
        insecure_context = ssl._create_unverified_context()
        with urllib.request.urlopen(request, timeout=30, context=insecure_context) as response:
            raw = response.read().decode("utf-8")
    data = json.loads(raw)
    content = data["choices"][0]["message"]["content"]
    result = _extract_json(content)
    result.setdefault("connected", True)
    result.setdefault("decision", "continue")
    result.setdefault("message", "")
    result["risk_flags"] = [*rule_result.get("risk_flags", []), *result.get("risk_flags", [])]
    result.setdefault("normalized_answer", "")
    return result


class PreviewHandler(BaseHTTPRequestHandler):
    def _send_cors_only(self, status: int = 204) -> None:
        self.send_response(status)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept")
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path in ("", "/"):
            path = "/mobile-preview.html"
        target = (PUBLIC / path.lstrip("/")).resolve()
        if PUBLIC not in target.parents and target != PUBLIC:
            self.send_error(403)
            return
        if not target.exists() or not target.is_file():
            self.send_error(404)
            return
        content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type + ("; charset=utf-8" if content_type.startswith("text/") else ""))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self) -> None:
        if self.path.split("?", 1)[0] == "/api/judge":
            self._send_cors_only(204)
            return
        self.send_error(404)

    def do_POST(self) -> None:
        if self.path.split("?", 1)[0] != "/api/judge":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
            result = judge_with_deepseek(payload)
            _json_response(self, 200, result)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            _json_response(self, exc.code, {"connected": True, "decision": "continue", "message": detail[:160], "risk_flags": []})
        except Exception as exc:
            _json_response(self, 500, {"connected": False, "decision": "continue", "message": str(exc)[:160], "risk_flags": []})

    def log_message(self, format: str, *args) -> None:
        print("%s - - [%s] %s" % (self.client_address[0], self.log_date_time_string(), format % args))


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8765"))
    server = ThreadingHTTPServer(("127.0.0.1", port), PreviewHandler)
    print(f"我行我诉 local preview listening on http://127.0.0.1:{port}/mobile-preview.html")
    server.serve_forever()
