#!/usr/bin/env python3
"""Reject wording that turns ordinary delivery into an out-of-band ritual."""

from __future__ import annotations

import argparse
import html
import pathlib
import re
import subprocess
import sys
import unicodedata


THIS_FILE = pathlib.PurePosixPath("scripts/check-release-language.py")
ROLE = "review" + "er"
AUTHORIZATION_NOUN = "appro" + "val"
AUTHORIZATION_VERB = "appro" + "ve"
COMPLETION_FIRST = "sign"
COMPLETION_SECOND = "off"
SEPARATOR_RUN = r"[\s_\-\u2010-\u2015]*"

PATTERNS = (
    (
        "authenticated release role",
        re.compile(rf"\bauthenticated\s+(?:release{SEPARATOR_RUN})?{ROLE}s?\b", re.I),
    ),
    (
        "required external role",
        re.compile(
            rf"\b(?:independent|external)\s+(?:release{SEPARATOR_RUN})?{ROLE}s?\s+(?:are\s+)?required\b",
            re.I,
        ),
    ),
    (
        "mandatory external review",
        re.compile(r"\bmandatory\s+(?:independent|external)\s+review\b", re.I),
    ),
    (
        "fixed role count",
        re.compile(
            rf"\b(?:five|5)\s+(?:distinct\s+)?(?:authenticated\s+)?(?:exact{SEPARATOR_RUN}head\s+)?{ROLE}s?\b",
            re.I,
        ),
    ),
    (
        "fixed authorization count",
        re.compile(
            rf"\b(?:five|5)\s+(?:exact{SEPARATOR_RUN}head\s+)?(?:independent\s+)?{AUTHORIZATION_NOUN}s?\b",
            re.I,
        ),
    ),
    (
        "required role",
        re.compile(rf"\brequired{SEPARATOR_RUN}{ROLE}s?\b", re.I),
    ),
    (
        "authenticated role",
        re.compile(rf"\b{ROLE}{SEPARATOR_RUN}authenticated\b", re.I),
    ),
    (
        "completion ritual",
        re.compile(
            rf"\b{COMPLETION_FIRST}(?:s|ed|ing)?{SEPARATOR_RUN}{COMPLETION_SECOND}s?\b",
            re.I,
        ),
    ),
    (
        "person-mediated gate",
        re.compile(rf"\b(?:manual|human){SEPARATOR_RUN}{AUTHORIZATION_NOUN}\b", re.I),
    ),
    (
        "waiting authorization state",
        re.compile(
            rf"\b(?:awaiting|pending|waiting{SEPARATOR_RUN}for){SEPARATOR_RUN}{AUTHORIZATION_NOUN}\b",
            re.I,
        ),
    ),
    (
        "obsolete owner checkpoint",
        re.compile(rf"\bowner{SEPARATOR_RUN}{AUTHORIZATION_NOUN}\b", re.I),
    ),
    (
        "obsolete authorization checkpoint",
        re.compile(rf"\b{AUTHORIZATION_NOUN}{SEPARATOR_RUN}(?:gate|checkpoint)\b", re.I),
    ),
    (
        "pre-action checkpoint",
        re.compile(
            rf"\b{AUTHORIZATION_NOUN}{SEPARATOR_RUN}before{SEPARATOR_RUN}"
            rf"(?:send(?:ing)?|submit(?:ting|sion)?|apply(?:ing)?|merge|release|deploy(?:ment|ing)?)\b",
            re.I,
        ),
    ),
    (
        "draft authorization state",
        re.compile(
            rf"\b(?:draft{SEPARATOR_RUN}{AUTHORIZATION_VERB}d|{AUTHORIZATION_VERB}d{SEPARATOR_RUN}drafts?)\b",
            re.I,
        ),
    ),
    (
        "application checkpoint command",
        re.compile(
            rf"\b{AUTHORIZATION_VERB}{SEPARATOR_RUN}this{SEPARATOR_RUN}(?:application|draft)\b",
            re.I,
        ),
    ),
    (
        "combined save checkpoint",
        re.compile(
            rf"\bsave{SEPARATOR_RUN}(?:&|and){SEPARATOR_RUN}{AUTHORIZATION_VERB}\b",
            re.I,
        ),
    ),
    (
        "edit-as-authorization claim",
        re.compile(
            rf"\bediting{SEPARATOR_RUN}counts{SEPARATOR_RUN}as{SEPARATOR_RUN}your{SEPARATOR_RUN}{AUTHORIZATION_NOUN}\b",
            re.I,
        ),
    ),
    (
        "hidden add checkpoint",
        re.compile(
            rf"\bonly{SEPARATOR_RUN}add[\s\S]{{0,160}}with{SEPARATOR_RUN}your{SEPARATOR_RUN}{AUTHORIZATION_NOUN}\b",
            re.I,
        ),
    ),
)

STRING_LITERAL = r'''(?:"(?:\\.|[^"\\])*+"|'(?:\\.|[^'\\])*+'|`(?:\\.|[^`\\$]|\$(?!\{))*+`)'''
STRING_LITERAL_RX = re.compile(STRING_LITERAL, re.S)
ESCAPED_STRING_LITERAL_RX = re.compile(
    r'''(?:"(?:[^"\\]|\\.)*\\.(?:[^"\\]|\\.)*"|'''
    r'''(?:'[^'\\]*(?:\\.[^'\\]*)*\\.(?:[^'\\]|\\.)*'))''',
    re.S,
)
PLAIN_STRING_LITERAL = r'''(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')'''
TEMPLATE_SUBSTITUTION_RX = re.compile(rf"\$\{{\s*({PLAIN_STRING_LITERAL})\s*\}}", re.S)
TEMPLATE_CONSTANT_RX = re.compile(
    rf"\x60(?:\\.|[^\x60\\$]|\$(?!\{{)|\$\{{\s*{PLAIN_STRING_LITERAL}\s*\}})*\x60",
    re.S,
)
JS_BLOCK_COMMENT = r"/\*(?:[^*]|\*(?!/))*\*/"
JS_COMMENT_GAP = (
    rf"(?:\s++|{JS_BLOCK_COMMENT}|"
    r"//[^\r\n\u2028\u2029]*(?:\r\n|\r|\n|\u2028|\u2029))*+"
)
STRING_CHAIN_RX = re.compile(
    rf"{STRING_LITERAL}(?:{JS_COMMENT_GAP}\+{JS_COMMENT_GAP}{STRING_LITERAL})+",
    re.S,
)
STRING_CHAIN_OPERATOR_RX = re.compile(rf"{JS_COMMENT_GAP}\+{JS_COMMENT_GAP}", re.S)
JSX_STRING_EXPRESSION_RX = re.compile(rf"\{{\s*({STRING_LITERAL})\s*\}}", re.S)
JSX_COMMENT_RX = re.compile(r"\{\s*/\*.*?\*/\s*\}", re.S)
JSX_TAG_RX = re.compile(r"</?[A-Za-z][^<>]*?>", re.S)
HTML_COMMENT_RX = re.compile(r"<!--.*?-->", re.S)
NON_RENDERED_BLOCK_RX = re.compile(
    r"<(script|style|template)\b[^>]*>.*?</\1\s*>",
    re.I | re.S,
)

DEFAULT_IGNORABLE_RANGES = (
    (0x034F, 0x034F),
    (0x115F, 0x1160),
    (0x17B4, 0x17B5),
    (0x180B, 0x180F),
    (0x2065, 0x2065),
    (0x3164, 0x3164),
    (0xFE00, 0xFE0F),
    (0xFFA0, 0xFFA0),
    (0xFFF0, 0xFFF8),
    (0xE0000, 0xE0FFF),
)

# Unicode general-category Cf ranges in the Python runtime used by CI. Keep
# this explicit list in addition to Default_Ignorable_Code_Point coverage:
# format controls and variation selectors are different Unicode properties.
FORMAT_CONTROL_RANGES = (
    (0x00AD, 0x00AD),
    (0x0600, 0x0605),
    (0x061C, 0x061C),
    (0x06DD, 0x06DD),
    (0x070F, 0x070F),
    (0x0890, 0x0891),
    (0x08E2, 0x08E2),
    (0x180E, 0x180E),
    (0x200B, 0x200F),
    (0x202A, 0x202E),
    (0x2060, 0x2064),
    (0x2066, 0x206F),
    (0xFEFF, 0xFEFF),
    (0xFFF9, 0xFFFB),
    (0x110BD, 0x110BD),
    (0x110CD, 0x110CD),
    (0x13430, 0x1343F),
    (0x1BCA0, 0x1BCA3),
    (0x1D173, 0x1D17A),
    (0xE0001, 0xE0001),
    (0xE0020, 0xE007F),
)


def codepoint_class(ranges: tuple[tuple[int, int], ...]) -> str:
    return "".join(
        chr(start) if start == end else chr(start) + "-" + chr(end)
        for start, end in ranges
    )


IGNORABLE_RX = re.compile(
    "[" + codepoint_class(FORMAT_CONTROL_RANGES + DEFAULT_IGNORABLE_RANGES) + "]"
)


def is_default_ignorable(char: str) -> bool:
    codepoint = ord(char)
    return any(start <= codepoint <= end for start, end in DEFAULT_IGNORABLE_RANGES)


def normalize_text(text: str) -> str:
    """Normalize compatibility forms and remove invisible format controls."""

    normalized = unicodedata.normalize("NFKC", text)
    # The overwhelming majority of a source revision is ASCII. Avoid a Python
    # callback for every character when no format or variation code point can
    # possibly be present; `isascii` performs this check in native code.
    if normalized.isascii():
        return normalized
    return IGNORABLE_RX.sub("", normalized)


def literal_value(literal: str) -> str:
    """Return visible content for a plain JS string literal without evaluating it."""

    body = literal[1:-1]
    decoded: list[str] = []
    index = 0
    simple_escapes = {
        "n": "\n",
        "r": "\n",
        "t": "\t",
        "'": "'",
        '"': '"',
        chr(96): chr(96),
        "\\": "\\",
    }

    def decoded_codepoint(value: str) -> str | None:
        try:
            codepoint = int(value, 16)
        except ValueError:
            return None
        if codepoint > 0x10FFFF or 0xD800 <= codepoint <= 0xDFFF:
            return None
        return chr(codepoint)

    while index < len(body):
        if body[index] != "\\" or index + 1 >= len(body):
            decoded.append(body[index])
            index += 1
            continue

        escape = body[index + 1]
        if escape in simple_escapes:
            decoded.append(simple_escapes[escape])
            index += 2
            continue
        if escape in ("\n", "\r", "\u2028", "\u2029"):
            index += 2
            if escape == "\r" and index < len(body) and body[index] == "\n":
                index += 1
            continue
        if escape == "x" and re.fullmatch(r"[0-9A-Fa-f]{2}", body[index + 2:index + 4]):
            decoded.append(decoded_codepoint(body[index + 2:index + 4]) or body[index:index + 4])
            index += 4
            continue
        if escape == "u":
            braced = re.match(r"\{([0-9A-Fa-f]{1,6})\}", body[index + 2:])
            if braced:
                raw = body[index:index + 2 + braced.end()]
                decoded.append(decoded_codepoint(braced.group(1)) or raw)
                index += 2 + braced.end()
                continue
            digits = body[index + 2:index + 6]
            if re.fullmatch(r"[0-9A-Fa-f]{4}", digits):
                decoded.append(decoded_codepoint(digits) or body[index:index + 6])
                index += 6
                continue

        # JavaScript's non-escape character form (for example \g in a
        # non-strict string) renders the escaped character without the slash.
        # Numeric and malformed hex/Unicode forms stay intact rather than
        # guessing at invalid syntax. An even slash pair was already consumed
        # by simple_escapes above, so it cannot unlock a following identity.
        if escape not in "0123456789xu":
            decoded.append(escape)
            index += 2
            continue

        # Keep an unknown or malformed escape intact. This avoids inventing
        # visible text for syntax that the projection does not understand.
        decoded.append(body[index:index + 2])
        index += 2
    return "".join(decoded)


def strip_source_comments(text: str) -> str:
    """Remove real source comments while preserving delimiters in literals."""

    if "<!--" not in text and "{/*" not in text:
        return text

    literals: list[str] = []

    def protect(match: re.Match[str]) -> str:
        literals.append(match.group(0))
        # Repository blobs containing NUL are excluded before text scanning,
        # so NUL-delimited placeholders cannot collide with source content.
        return f"\0{len(literals) - 1}\0"

    # Protect only syntactically bounded rendered expressions/chains plus a
    # standalone literal whose own value is comment-shaped. Protecting every
    # quote pair would mistake apostrophes in JSX prose or Markdown for a JS
    # string and could preserve a real source comment between them.
    protected = TEMPLATE_CONSTANT_RX.sub(protect, text)
    protected = STRING_CHAIN_RX.sub(protect, protected)
    protected = JSX_STRING_EXPRESSION_RX.sub(protect, protected)

    def protect_comment_shaped_literal(match: re.Match[str]) -> str:
        body = match.group(0)[1:-1].strip()
        if (
            (body.startswith("<!--") and body.endswith("-->"))
            or (body.startswith("{/*") and body.endswith("*/}"))
        ):
            return protect(match)
        return match.group(0)

    protected = STRING_LITERAL_RX.sub(protect_comment_shaped_literal, protected)
    protected = HTML_COMMENT_RX.sub("", protected)
    protected = JSX_COMMENT_RX.sub("", protected)
    return re.sub(r"\0(\d+)\0", lambda match: literals[int(match.group(1))], protected)


def template_constant_value(template: str) -> str:
    """Render a template whose substitutions are themselves plain literals."""

    body = template[1:-1]
    values: list[str] = []
    cursor = 0
    marker = chr(96)
    for match in TEMPLATE_SUBSTITUTION_RX.finditer(body):
        values.append(literal_value(marker + body[cursor:match.start()] + marker))
        values.append(literal_value(match.group(1)))
        cursor = match.end()
    values.append(literal_value(marker + body[cursor:] + marker))
    return "".join(values)


def rendered_source_projection(text: str) -> str:
    """Project common JSX and literal concatenation boundaries into visible text.

    Raw whole-file scanning cannot see a label split across sibling JSX nodes or
    directly concatenated string literals. This conservative projection removes
    non-rendered JSX wrappers and joins only literal-only concatenations; it does
    not execute code or interpolate variables.
    """

    # Decode character references before projecting markup. Browsers render
    # both named references (for example a non-breaking space) and numeric
    # references as characters, so scanning their source spelling alone would
    # miss wording assembled at that boundary. Normalize again afterwards so
    # decoded format controls cannot create a second invisible separator path.
    # `prohibited_labels` passes normalized text. Keep projection transforms
    # conditional so large lockfiles and generated source do not pay for every
    # grammar pass when the relevant token is absent.
    projected = text
    lower_projected = projected.lower() if "<" in projected else ""
    if any(tag in lower_projected for tag in ("<script", "<style", "<template")):
        projected = NON_RENDERED_BLOCK_RX.sub("", projected)
    # Strip only comments that are comments in the source grammar. Encoded
    # delimiters render as ordinary visible text in a browser; decoding first
    # and then deleting them would incorrectly hide that visible content.
    projected = strip_source_comments(projected)
    if "&" in projected:
        decoded_entities = html.unescape(projected)
        projected = normalize_text(decoded_entities) if decoded_entities != projected else projected
    if "`" in projected and "${" in projected:
        projected = TEMPLATE_CONSTANT_RX.sub(
            lambda match: template_constant_value(match.group(0)),
            projected,
        )
    if "{" in projected and ("'" in projected or '"' in projected or "`" in projected):
        projected = JSX_STRING_EXPRESSION_RX.sub(
            lambda match: literal_value(match.group(1)),
            projected,
        )

    def join_literals(match: re.Match[str]) -> str:
        # Literal-only JavaScript concatenation has no implicit separator.
        # Preserve that exact rendered value so chains may split words as well
        # as whitespace, including chains of three or more literals.
        chain = match.group(0)
        values: list[str] = []
        first = STRING_LITERAL_RX.match(chain)
        if not first:
            return chain
        values.append(literal_value(first.group(0)))
        cursor = first.end()
        while cursor < len(chain):
            operator = STRING_CHAIN_OPERATOR_RX.match(chain, cursor)
            if not operator:
                return chain
            item = STRING_LITERAL_RX.match(chain, operator.end())
            if not item:
                return chain
            values.append(literal_value(item.group(0)))
            cursor = item.end()
        return "".join(values)

    if "+" in projected and ("'" in projected or '"' in projected or "`" in projected):
        projected = STRING_CHAIN_RX.sub(join_literals, projected)
    # Decode escape-bearing literals even when they are not wrapped in JSX or
    # part of a concatenation. This includes identity and line-continuation
    # escapes, but the literal parser deliberately preserves malformed numeric
    # or Unicode syntax and paired backslashes.
    if "\\" in projected and ("'" in projected or '"' in projected):
        projected = ESCAPED_STRING_LITERAL_RX.sub(
            lambda match: literal_value(match.group(0)),
            projected,
        )
    if "<" in projected and ">" in projected:
        projected = JSX_TAG_RX.sub("", projected)
    return projected


def prohibited_labels(text: str) -> list[str]:
    normalized = normalize_text(text)
    rendered = rendered_source_projection(normalized)
    return [
        label
        for label, pattern in PATTERNS
        if pattern.search(normalized)
        or (rendered != normalized and pattern.search(rendered))
    ]


def repository_root() -> pathlib.Path:
    root = subprocess.check_output(
        ["git", "rev-parse", "--show-toplevel"], text=True
    ).strip()
    return pathlib.Path(root)


def tracked_index_entries(root: pathlib.Path) -> list[tuple[pathlib.Path, str | None]]:
    """Return root-relative tracked paths and their stage-zero blob ids."""

    raw_entries = subprocess.check_output(
        ["git", "ls-files", "--stage", "--full-name", "-z"], cwd=root
    ).split(b"\0")
    entries: list[tuple[pathlib.Path, str | None]] = []
    for raw_entry in raw_entries:
        if not raw_entry:
            continue
        metadata, raw_path = raw_entry.split(b"\t", 1)
        mode, raw_oid, stage = metadata.split(b" ", 2)
        if stage != b"0" or mode == b"160000":
            continue
        oid = raw_oid.decode("ascii")
        if not oid.strip("0"):
            oid = None
        entries.append((pathlib.Path(raw_path.decode("utf-8", "surrogateescape")), oid))
    return entries


def read_index_blobs(root: pathlib.Path, object_ids: list[str]) -> dict[str, bytes]:
    """Read every requested index blob through one Git batch process."""

    unique_ids = list(dict.fromkeys(object_ids))
    if not unique_ids:
        return {}
    process = subprocess.Popen(
        ["git", "cat-file", "--batch"],
        cwd=root,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    output, error = process.communicate(
        "".join(f"{oid}\n" for oid in unique_ids).encode("ascii")
    )
    if process.returncode:
        raise subprocess.CalledProcessError(
            process.returncode, process.args, output=output, stderr=error
        )

    blobs: dict[str, bytes] = {}
    offset = 0
    for requested_oid in unique_ids:
        header_end = output.find(b"\n", offset)
        if header_end < 0:
            raise RuntimeError("git cat-file returned a truncated header")
        header = output[offset:header_end].split()
        if len(header) != 3 or header[1] != b"blob":
            raise RuntimeError(f"git cat-file did not return blob {requested_oid}")
        size = int(header[2])
        data_start = header_end + 1
        data_end = data_start + size
        if data_end >= len(output) or output[data_end:data_end + 1] != b"\n":
            raise RuntimeError(f"git cat-file returned a truncated blob {requested_oid}")
        blobs[requested_oid] = output[data_start:data_end]
        offset = data_end + 1
    return blobs


def scan_repository() -> list[tuple[str, list[str]]]:
    violations: list[tuple[str, list[str]]] = []
    root = repository_root()
    entries = tracked_index_entries(root)
    blobs = read_index_blobs(root, [oid for _, oid in entries if oid])
    for path, oid in entries:
        if pathlib.PurePosixPath(path.as_posix()) == THIS_FILE:
            continue
        # A present index blob is always authoritative. The worktree fallback
        # is reserved for an intent-to-add entry that has no blob yet.
        data = blobs[oid] if oid else (root / path).read_bytes()
        if b"\0" in data:
            continue
        labels = prohibited_labels(data.decode("utf-8", "ignore"))
        if labels:
            violations.append((path.as_posix(), labels))
    return violations


def run_self_test() -> None:
    backslash = chr(92)
    template_tick = chr(96)
    compatibility_completion = "".join(
        "\u3000" if char == " " else chr(ord(char) + 0xFEE0)
        for char in COMPLETION_FIRST + " " + COMPLETION_SECOND
    )
    positive_probes = {
        "line break": "owner " + COMPLETION_FIRST + "\n" + COMPLETION_SECOND + " required",
        "underscore": "owner " + COMPLETION_FIRST + "ed_" + COMPLETION_SECOND + " required",
        "hyphen and line break": "owner " + COMPLETION_FIRST + "ing-\n" + COMPLETION_SECOND,
        "unicode hyphen": "owner " + COMPLETION_FIRST + "\u2011" + COMPLETION_SECOND,
        "zero width control": "owner " + COMPLETION_FIRST + "\u200b" + COMPLETION_SECOND,
        "third person completion": "owner " + COMPLETION_FIRST + "s " + COMPLETION_SECOND,
        "gerund completion": "owner " + COMPLETION_FIRST + "ing " + COMPLETION_SECOND,
        "plural hyphen completion": "owner " + COMPLETION_FIRST + "-" + COMPLETION_SECOND + "s",
        "compact plural completion": "owner " + COMPLETION_FIRST + COMPLETION_SECOND + "s",
        "role separator": "required_\n" + ROLE,
        "wrapped person gate": "man" + "ual_\n" + AUTHORIZATION_NOUN,
        "wrapped state": "await" + "ing-\n" + AUTHORIZATION_NOUN,
        "wrapped checkpoint": AUTHORIZATION_NOUN + "_\n" + "gate",
        "wrapped draft state": AUTHORIZATION_VERB + "d-\n" + "draft",
        "JSX sibling boundary": (
            "<p>{'" + COMPLETION_FIRST + "'}<span>{'" + COMPLETION_SECOND + "'}</span></p>"
        ),
        "JSX text boundary": (
            "<strong>" + "man" + "<em>ual</em></strong> " + AUTHORIZATION_NOUN
        ),
        "literal concatenation": (
            "const status = '" + COMPLETION_FIRST + "' + '" + COMPLETION_SECOND + "'"
        ),
        "three literal token chain": (
            "const status = 'si' + 'gn' + '" + COMPLETION_SECOND + "'"
        ),
        "four literal person gate": (
            "const status = 'man' + 'ual' + ' ' + '" + AUTHORIZATION_NOUN + "'"
        ),
        "named character reference": (
            "<p>{'" + COMPLETION_FIRST + "'}&nbsp;{'" + COMPLETION_SECOND + "'}</p>"
        ),
        "decimal character reference": (
            "owner " + COMPLETION_FIRST + "&#32;" + COMPLETION_SECOND
        ),
        "hex character reference": (
            "owner " + COMPLETION_FIRST + "&#x2d;" + COMPLETION_SECOND
        ),
        "encoded invisible control": (
            "owner " + COMPLETION_FIRST + "&#8203;" + COMPLETION_SECOND
        ),
        "encoded comment delimiters are visible": (
            "<p>&lt;!-- si&#103;n " + COMPLETION_SECOND + " --&gt;</p>"
        ),
        "comment delimiters inside a JSX string are visible": (
            "<p>{\"<!-- si&#103;n " + COMPLETION_SECOND + " -->\"}</p>"
        ),
        "unicode escape in a JSX string": (
            "<p>{'si\\u0067n " + COMPLETION_SECOND + "'}</p>"
        ),
        "hex escape in a JSX string": (
            "<p>{'si\\x67n " + COMPLETION_SECOND + "'}</p>"
        ),
        "compatibility normalization": "owner " + compatibility_completion,
        "combining grapheme joiner": "owner si\u034fgn " + COMPLETION_SECOND,
        "variation selector": "owner si\ufe0fgn " + COMPLETION_SECOND,
        "supplemental variation selector": "owner si\U000e0100gn " + COMPLETION_SECOND,
        "padded braced unicode escape": (
            "<p>{'si" + backslash + "u{000067}n " + COMPLETION_SECOND + "'}</p>"
        ),
        "LF continuation": (
            "<p>{'si" + backslash + "\n" + "gn " + COMPLETION_SECOND + "'}</p>"
        ),
        "CR continuation": (
            "<p>{'si" + backslash + "\r" + "gn " + COMPLETION_SECOND + "'}</p>"
        ),
        "CRLF continuation": (
            "<p>{'si" + backslash + "\r\n" + "gn " + COMPLETION_SECOND + "'}</p>"
        ),
        "line separator continuation": (
            "<p>{'si" + backslash + "\u2028" + "gn " + COMPLETION_SECOND + "'}</p>"
        ),
        "paragraph separator continuation": (
            "<p>{'si" + backslash + "\u2029" + "gn " + COMPLETION_SECOND + "'}</p>"
        ),
        "identity escape": (
            "<p>{'si" + backslash + "gn " + COMPLETION_SECOND + "'}</p>"
        ),
        "standalone identity escape": (
            "const label = 'si" + backslash + "gn " + COMPLETION_SECOND + "'"
        ),
        "constant template substitution": (
            "const label = " + template_tick + "si${'gn'} "
            + COMPLETION_SECOND + template_tick
        ),
        "block comment between literal fragments": (
            "const label = 'si' + /* harmless note */ 'gn ' + '"
            + COMPLETION_SECOND + "'"
        ),
        "line comment between literal fragments": (
            "const label = 'si' + // harmless note\n'gn ' + '"
            + COMPLETION_SECOND + "'"
        ),
    }
    negative_probes = {
        "cryptographic signature": "The commit is cryptographically signed.",
        "evidence record": "The operator records deployment evidence.",
        "scientific review": "Review source design and uncertainty.",
        "identity challenge": "Pause for login, CAPTCHA, or two-factor authentication.",
        "transaction consent": "Ask the user to confirm payment before purchase.",
        "personal attestation": "The applicant must personally attest to these facts.",
        "regulated review": "Document IRB authorization for human-subjects research.",
        "larger lexical prefix": "The assignment offers deterministic work distribution.",
        "larger lexical suffix": "A sign officer witnesses the applicant signature.",
        "identifier boundary": "const presign_officer = verify_signature();",
        "authorization identifier suffix": "const manual_approvalQueueSize = 0;",
        "even slash identity negative": (
            "const label = 'si" + backslash + backslash + "gn "
            + COMPLETION_SECOND + "'"
        ),
        "non-rendered script body": (
            "<script>const label = 'si' + 'gn ' + '" + COMPLETION_SECOND + "'</script>"
        ),
        "non-rendered style body": (
            "<style>.label::after { content: 'si' + 'gn ' + '"
            + COMPLETION_SECOND + "'; }</style>"
        ),
        "non-rendered template body": (
            "<template><span>si&#103;n " + COMPLETION_SECOND + "</span></template>"
        ),
    }

    missed = [name for name, probe in positive_probes.items() if not prohibited_labels(probe)]
    false_positives = [name for name, probe in negative_probes.items() if prohibited_labels(probe)]
    if missed or false_positives:
        details = []
        if missed:
            details.append("missed probes: " + ", ".join(missed))
        if false_positives:
            details.append("false positives: " + ", ".join(false_positives))
        raise AssertionError("; ".join(details))
    print("Release language scanner self-test passed.")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        run_self_test()
        return 0

    violations = scan_repository()
    if violations:
        print("Prohibited delivery-gate language found:")
        for path, labels in violations:
            print(f"{path}: {', '.join(labels)}")
        return 1

    print("Release language policy passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
