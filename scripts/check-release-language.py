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

STRING_LITERAL = r'''(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\$]|\$(?!\{))*`)'''
STRING_LITERAL_RX = re.compile(STRING_LITERAL, re.S)
STRING_CHAIN_RX = re.compile(rf"{STRING_LITERAL}(?:\s*\+\s*{STRING_LITERAL})+", re.S)
JSX_STRING_EXPRESSION_RX = re.compile(rf"\{{\s*({STRING_LITERAL})\s*\}}", re.S)
JSX_COMMENT_RX = re.compile(r"\{\s*/\*.*?\*/\s*\}", re.S)
JSX_TAG_RX = re.compile(r"</?[A-Za-z][^<>]*?>", re.S)
HTML_COMMENT_RX = re.compile(r"<!--.*?-->", re.S)


def normalize_text(text: str) -> str:
    """Normalize compatibility forms and remove invisible format controls."""

    normalized = unicodedata.normalize("NFKC", text)
    return "".join(char for char in normalized if unicodedata.category(char) != "Cf")


def literal_value(literal: str) -> str:
    """Return visible content for a plain JS string literal without evaluating it."""

    body = literal[1:-1]
    replacements = {
        r"\n": "\n",
        r"\r": "\n",
        r"\t": "\t",
        r"\'": "'",
        r'\"': '"',
        r"\`": "`",
        r"\\": "\\",
    }
    for escaped, value in replacements.items():
        body = body.replace(escaped, value)
    return body


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
    projected = normalize_text(text)
    # Strip only comments that are comments in the source grammar. Encoded
    # delimiters render as ordinary visible text in a browser; decoding first
    # and then deleting them would incorrectly hide that visible content.
    projected = HTML_COMMENT_RX.sub("", projected)
    projected = JSX_COMMENT_RX.sub("", projected)
    projected = normalize_text(html.unescape(projected))
    projected = JSX_STRING_EXPRESSION_RX.sub(lambda match: literal_value(match.group(1)), projected)

    def join_literals(match: re.Match[str]) -> str:
        # Literal-only JavaScript concatenation has no implicit separator.
        # Preserve that exact rendered value so chains may split words as well
        # as whitespace, including chains of three or more literals.
        return "".join(literal_value(item.group(0)) for item in STRING_LITERAL_RX.finditer(match.group(0)))

    projected = STRING_CHAIN_RX.sub(join_literals, projected)
    projected = JSX_TAG_RX.sub("", projected)
    return projected


def prohibited_labels(text: str) -> list[str]:
    normalized = normalize_text(text)
    rendered = rendered_source_projection(normalized)
    return [
        label
        for label, pattern in PATTERNS
        if pattern.search(normalized) or pattern.search(rendered)
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
