#!/usr/bin/env python3
"""邮箱简历抓取（只读、不删邮件）。

用法：
  python3 fetch_mail.py --config recruiting/mail.json --check
  python3 fetch_mail.py --config recruiting/mail.json
  python3 fetch_mail.py --config recruiting/mail.json --upload http://127.0.0.1:62947

配置见 mail.example.json。密码也可由环境变量 RECRUIT_MAIL_PASSWORD 提供，
避免明文落盘。抓取结果（附件原件）落在 <dataDir>/inbox/，去重账本 mail_seen.json。
"""
import argparse
import base64
import email
import hashlib
import imaplib
import json
import os
import poplib
import re
import sys
import urllib.request
from email.header import decode_header, make_header

RESUME_EXT = {".pdf", ".docx", ".doc", ".rtf", ".txt", ".html", ".htm",
              ".md", ".png", ".jpg", ".jpeg", ".webp", ".tiff", ".bmp"}


def dec(s):
    if not s:
        return ""
    try:
        return str(make_header(decode_header(s)))
    except Exception:
        return str(s)


def safe_name(s):
    return re.sub(r"[/\\:*?\"<>|\r\n\t]", "_", (s or "attachment"))[:120]


def load_config(path):
    cfg = json.load(open(path, encoding="utf-8"))
    if os.environ.get("RECRUIT_MAIL_PASSWORD"):
        cfg["password"] = os.environ["RECRUIT_MAIL_PASSWORD"]
    required = ["host", "user", "password", "protocol"]
    missing = [k for k in required if not cfg.get(k)]
    if missing:
        raise ValueError("配置缺少字段：" + ", ".join(missing) + "；参考 mail.example.json")
    cfg.setdefault("port", 993 if cfg["protocol"] == "imap" else 995)
    cfg.setdefault("ssl", True)
    cfg.setdefault("folder", "INBOX")
    cfg.setdefault("criteria", "UNSEEN")
    cfg.setdefault("limit", 50)
    cfg.setdefault("dataDir", os.path.dirname(os.path.abspath(path)))
    cfg.setdefault("source", "其他")
    cfg.setdefault("autoSource", True)
    cfg.setdefault("defaultPositionId", "")
    cfg.setdefault("markSeen", False)
    return cfg


def seen_path(cfg):
    return os.path.join(cfg["dataDir"], "mail_seen.json")


def load_seen(cfg):
    p = seen_path(cfg)
    if os.path.exists(p):
        try:
            return json.load(open(p, encoding="utf-8"))
        except Exception:
            return {}
    return {}


def save_seen(cfg, seen):
    os.makedirs(cfg["dataDir"], exist_ok=True)
    json.dump(seen, open(seen_path(cfg), "w", encoding="utf-8"), ensure_ascii=False, indent=2)


def attachments_from_msg(msg):
    out = []
    for part in msg.walk():
        if part.get_content_maintype() == "multipart":
            continue
        fn = part.get_filename()
        if not fn:
            continue
        fn = dec(fn)
        ext = os.path.splitext(fn)[1].lower()
        if ext not in RESUME_EXT:
            continue
        data = part.get_payload(decode=True)
        if not data:
            continue
        out.append((fn, ext, data))
    return out


def fetch_imap(cfg):
    cls = imaplib.IMAP4_SSL if cfg["ssl"] else imaplib.IMAP4
    conn = cls(cfg["host"], int(cfg["port"]))
    conn.login(cfg["user"], cfg["password"])
    conn.select(cfg["folder"], readonly=not cfg["markSeen"])
    typ, data = conn.search(None, cfg["criteria"])
    ids = (data[0] or b"").split()[:int(cfg["limit"])]
    out = []
    for mid in ids:
        typ, raw = conn.fetch(mid, "(RFC822)")
        if typ != "OK" or not raw or not raw[0]:
            continue
        msg = email.message_from_bytes(raw[0][1])
        for fn, ext, blob in attachments_from_msg(msg):
            out.append({
                "filename": fn, "ext": ext, "data": blob,
                "messageId": dec(msg.get("Message-ID")) or mid.decode(),
                "from": dec(msg.get("From")), "subject": dec(msg.get("Subject")),
                "date": dec(msg.get("Date")),
            })
    try:
        conn.close()
    except Exception:
        pass
    conn.logout()
    return out


def fetch_pop3(cfg):
    cls = poplib.POP3_SSL if cfg["ssl"] else poplib.POP3
    conn = cls(cfg["host"], int(cfg["port"]))
    conn.user(cfg["user"])
    conn.pass_(cfg["password"])
    count = len(conn.list()[1])[:int(cfg["limit"])]
    out = []
    for i in range(1, count + 1):
        try:
            lines = b"\n".join(conn.retr(i)[1])
            msg = email.message_from_bytes(lines)
        except Exception:
            continue
        for fn, ext, blob in attachments_from_msg(msg):
            out.append({
                "filename": fn, "ext": ext, "data": blob,
                "messageId": dec(msg.get("Message-ID")) or str(i),
                "from": dec(msg.get("From")), "subject": dec(msg.get("Subject")),
                "date": dec(msg.get("Date")),
            })
    conn.quit()
    return out


# 渠道自动归因规则：按「发件人域名 / 主题 / 文件名」识别简历来自哪个招聘平台。
# 可在设置里覆盖（mail.json 的 sourceRules）。命中即归因，未命中用默认 source。
DEFAULT_SOURCE_RULES = [
    {"source": "BOSS直聘", "match": ["boss直聘", "bosszhipin", "zhipin.com", "boss@"]},
    {"source": "猎聘", "match": ["猎聘", "liepin", "lietou.com"]},
    {"source": "智联招聘", "match": ["智联", "zhilian", "zhaopin.com", "zhaopinmail"]},
    {"source": "前程无忧", "match": ["前程无忧", "51job", "51jobmail"]},
    {"source": "拉勾", "match": ["拉勾", "lagou"]},
    {"source": "官网", "match": ["官网", "official", "careers@", "jobs@"]},
    {"source": "猎头", "match": ["猎头", "headhunter", "顾问推荐"]},
    {"source": "内推", "match": ["内推", "referral", "内部推荐"]},
    {"source": "校招", "match": ["校招", "校园招聘", "campus"]},
]


def attribute_source(cfg, item):
    """按规则把一封简历邮件归因到渠道。返回 (source, reason, confidence)。"""
    rules = cfg.get("sourceRules") or DEFAULT_SOURCE_RULES
    # 拼合可匹配字段：发件人 + 主题 + 文件名
    hay = " ".join([
        str(item.get("from") or ""),
        str(item.get("subject") or ""),
        str(item.get("filename") or ""),
    ]).lower()
    for r in rules:
        src = r.get("source") or "其他"
        for kw in (r.get("match") or []):
            if kw and kw.lower() in hay:
                return src, "命中「%s」" % kw, "mid"
    # 没命中：用配置默认值
    return cfg["source"], "未识别渠道特征，用默认来源", "low"


def push_upload(url, cfg, item):
    src, why, conf = (cfg["source"], "固定来源", "low")
    if cfg.get("autoSource", True):
        src, why, conf = attribute_source(cfg, item)
    body = {
        "name": item.get("name") or "",
        "filename": item["filename"],
        "contentBase64": base64.b64encode(item["data"]).decode("ascii"),
        "positionId": cfg["defaultPositionId"],
        "source": src,
        "sourceReason": why,
        "sourceConf": conf,
        "from": item["from"], "subject": item["subject"], "date": item["date"],
        "messageId": item["messageId"],
    }
    req = urllib.request.Request(
        url.rstrip("/") + "/api/ai-recruiting/upload",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--check", action="store_true", help="只校验配置，不连邮箱")
    ap.add_argument("--upload", default="", help="工作台 URL，直接推送附件并入库")
    ap.add_argument("--dry-run", action="store_true", help="抓取但不落盘、不推送")
    a = ap.parse_args()
    try:
        cfg = load_config(a.config)
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        return 1
    if a.check:
        print(json.dumps({"ok": True, "message": "配置有效",
                          "protocol": cfg["protocol"], "host": cfg["host"], "port": cfg["port"],
                          "folder": cfg["folder"], "criteria": cfg["criteria"],
                          "passwordFromEnv": bool(os.environ.get("RECRUIT_MAIL_PASSWORD"))}, ensure_ascii=False))
        return 0
    try:
        items = fetch_imap(cfg) if cfg["protocol"] == "imap" else fetch_pop3(cfg)
    except Exception as e:
        print(json.dumps({"ok": False, "error": "邮箱连接失败：%s: %s" % (type(e).__name__, e)}, ensure_ascii=False))
        return 1

    seen = load_seen(cfg)
    inbox_dir = os.path.join(cfg["dataDir"], "inbox")
    if not a.dry_run:
        os.makedirs(inbox_dir, exist_ok=True)
    results, skipped = [], 0
    for it in items:
        h = hashlib.sha256(it["data"]).hexdigest()
        key = it["messageId"] + ":" + h
        if key in seen:
            skipped += 1
            continue
        path = ""
        if not a.dry_run:
            path = os.path.join(inbox_dir, safe_name(it["messageId"]) + "_" + safe_name(it["filename"]))
            open(path, "wb").write(it["data"])
            seen[key] = {"filename": it["filename"], "from": it["from"],
                         "subject": it["subject"], "date": it["date"]}
        rec = {"filename": it["filename"], "bytes": len(it["data"]),
               "from": it["from"], "subject": it["subject"], "date": it["date"],
               "messageId": it["messageId"], "sha256": h, "path": path}
        if a.upload and not a.dry_run:
            try:
                rec["upload"] = push_upload(a.upload, cfg, it)
            except Exception as e:
                rec["uploadError"] = str(e)
        results.append(rec)
    if not a.dry_run:
        save_seen(cfg, seen)
    print(json.dumps({"ok": True, "scanned": len(items), "attachments": results,
                      "skippedDuplicates": skipped, "dryRun": a.dry_run}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
