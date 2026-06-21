#!/usr/bin/env python3
"""Build a single .docx containing the ENTIRE GrantFlow repository, organized
Section -> File -> individual numbered lines.

Primary sections (as requested): Frontend, Middleware, Backend.
Remaining tracked files are grouped into sensible buckets with a final
catch-all so nothing in the repo is omitted. Binary files (PDF/MP4/images)
can't be rendered as text, so they're listed in an appendix.

Streams word/document.xml straight to disk to stay memory-light. No deps.
"""
import os
import sys
import subprocess
import zipfile
import datetime

REPO = os.path.expanduser("~/GrantFlow")
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(REPO, "Code for GrantFlow.docx")

def git_ls():
    out = subprocess.check_output(["git", "-C", REPO, "ls-files"], text=True)
    return [l for l in out.splitlines() if l.strip()]

all_files = sorted(git_ls())

# ---- exclusive, ordered classification: first match wins ----
def is_infra(p):
    lp = p.lower()
    return (p in ("Dockerfile", ".dockerignore", "vercel.json", "railway.json",
                  "vite.config.ts", "tailwind.config.js", "postcss.config.js",
                  "eslint.config.js", "vitest.config.js", "vitest.setup.js",
                  "package.json", "package-lock.json", "index.html",
                  "jsconfig.json", ".nvmrc", ".npmrc", ".gitattributes",
                  ".gitignore", ".cursorignore", ".gitleaks.toml")
            or lp.startswith("docker-compose")
            or lp.endswith(".dockerfile")
            or p.startswith("nginx/") or p.startswith("systemd/")
            or p.startswith(".github/") or p.startswith(".githooks/")
            or p.startswith(".cursor/")
            or p.startswith("tsconfig"))

BUCKETS = [
    ("Frontend", lambda p: p.startswith("src/")),
    ("Middleware", lambda p: p.startswith("backend/middleware/")),
    ("Backend", lambda p: p.startswith("backend/") or p.startswith("shared/")),
    ("Database (SQL & Migrations)", lambda p: p.endswith(".sql")),
    ("Tests", lambda p: p.startswith("tests/") or p.startswith("test-results/")),
    ("Scripts & Tooling", lambda p: p.startswith("scripts/") or p.startswith("tools/")
        or p.endswith(".ps1") or p.endswith(".sh")),
    ("Infrastructure, Deployment & Config", is_infra),
    ("Documentation", lambda p: p.endswith(".md") or p.endswith(".mdc")
        or p.startswith("docs/")),
    ("Seed, Design & Data", lambda p: p.startswith("seed/") or p.startswith("design/")
        or p.startswith("artifacts/") or p.startswith("audit-parts/")
        or p.startswith("data/")),
    ("Public & Static Assets", lambda p: p.startswith("public/")),
    ("Other Project Files", lambda p: True),  # catch-all
]

sectioned = {name: [] for name, _ in BUCKETS}
for path in all_files:
    for name, match in BUCKETS:
        if match(path):
            sectioned[name].append(path)
            break

# ---- binary detection ----
def is_binary(full):
    try:
        with open(full, "rb") as fh:
            chunk = fh.read(8192)
        return b"\x00" in chunk
    except Exception:
        return True

def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

def clean(s):
    return "".join(ch for ch in s if ch == "\t" or ch >= " ")

def p(f, text, style=None):
    pPr = f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>' if style else ""
    f.write(f'<w:p>{pPr}<w:r><w:t xml:space="preserve">{esc(text)}</w:t></w:r></w:p>')

body_path = OUT + ".body.tmp"
total_files = 0
total_lines = 0
binaries = []

with open(body_path, "w", encoding="utf-8") as f:
    p(f, "Code for GrantFlow", "Title")
    p(f, f"Complete repository export — generated {datetime.date.today().isoformat()}", "Subtitle")
    p(f, "Repository: github.com/buckeye7066/GrantFlow", "Subtitle")
    p(f, "", None)
    p(f, "Contents", "Heading1")
    for name, _ in BUCKETS:
        files = sectioned[name]
        if files:
            p(f, f"{name} — {len(files)} files", "Heading3")

    for name, _ in BUCKETS:
        files = sectioned[name]
        if not files:
            continue
        p(f, name, "Heading1")
        for path in files:
            full = os.path.join(REPO, path)
            if is_binary(full):
                try:
                    sz = os.path.getsize(full)
                except OSError:
                    sz = -1
                binaries.append((path, sz))
                p(f, path, "Heading2")
                p(f, f"[binary file — not rendered as text; {sz:,} bytes]", "Code")
                total_files += 1
                continue
            try:
                with open(full, "r", encoding="utf-8", errors="replace") as src:
                    lines = src.read().split("\n")
            except Exception as e:
                lines = [f"<<could not read file: {e}>>"]
            total_files += 1
            p(f, path, "Heading2")
            for i, line in enumerate(lines, 1):
                p(f, f"{i:>6}  {clean(line)}", "Code")
                total_lines += 1

    # appendix
    if binaries:
        p(f, "Appendix: Binary Files (not text-rendered)", "Heading1")
        for path, sz in binaries:
            p(f, f"{path}  —  {sz:,} bytes", "Code")

doc_path = OUT + ".document.tmp"
DOC_HEAD = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>')
DOC_TAIL = ('<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>'
    '<w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="0" w:footer="0" w:gutter="0"/>'
    '</w:sectPr></w:body></w:document>')
with open(doc_path, "w", encoding="utf-8") as out:
    out.write(DOC_HEAD)
    with open(body_path, "r", encoding="utf-8") as b:
        while True:
            chunk = b.read(1 << 20)
            if not chunk:
                break
            out.write(chunk)
    out.write(DOC_TAIL)

CONTENT_TYPES = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    '</Types>')
RELS = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    '</Relationships>')
DOC_RELS = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    '</Relationships>')
STYLES = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>'
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
    '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="56"/><w:color w:val="1F3864"/></w:rPr></w:style>'
    '<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:rPr><w:i/><w:sz w:val="24"/><w:color w:val="595959"/></w:rPr></w:style>'
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:pageBreakBefore/><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/><w:color w:val="1F3864"/></w:rPr></w:style>'
    '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:spacing w:before="200" w:after="80"/><w:shd w:val="clear" w:fill="D9E2F3"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/><w:color w:val="2E5496"/></w:rPr></w:style>'
    '<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:pPr><w:spacing w:before="120" w:after="60"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>'
    '<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="16"/></w:rPr></w:style>'
    '</w:styles>')

with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    z.writestr("[Content_Types].xml", CONTENT_TYPES)
    z.writestr("_rels/.rels", RELS)
    z.writestr("word/_rels/document.xml.rels", DOC_RELS)
    z.writestr("word/styles.xml", STYLES)
    z.write(doc_path, "word/document.xml")

os.remove(body_path)
os.remove(doc_path)
size_mb = os.path.getsize(OUT) / (1024 * 1024)
print("=== section counts ===")
for name, _ in BUCKETS:
    if sectioned[name]:
        print(f"  {name}: {len(sectioned[name])} files")
print(f"Binary files: {len(binaries)}")
print(f"Wrote {OUT}")
print(f"Total files: {total_files}  Total lines: {total_lines:,}  Size: {size_mb:.1f} MB")
