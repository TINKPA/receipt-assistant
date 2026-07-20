# Curated extractor lessons — human-reviewed, one per line.
#
# These are promoted (via the agent-evolver skill / a human) from the
# runtime `lessons.proposed.md` the agent appends to on the mini. Every
# non-'#' line below is injected VERBATIM into the extractor prompt as
# high-priority guidance, so keep each one short, specific, and evidence-
# based. Lines starting with '#' are comments and are NOT injected.
#
# Promotion is a normal repo change: add the line here, commit, deploy.
# See .claude/skills/agent-evolver/SKILL.md (Diagnose → Step 0).

- [receipt_pdf] The printed transaction date can differ from the PDF's CreationDate metadata (the template/software date). Trust the printed receipt date, not the file metadata. (Promoted 2026-07-19 from an AAA/Club Assist invoice.)
