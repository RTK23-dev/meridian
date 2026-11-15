// The video skills Meridian offers to Claude Code. They ship with the code, in .claude/skills, and are read when asked for, never at
// module load (source-file.ts says why). Only the skills named below are offered: the ones that make a video. The engine's own
// working rules stay out. A skill is plain text; Claude Code writes it to its own .claude/skills folder, and Meridian runs none of it.

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The video skills, in the order they are offered. */
export const VIDEO_SKILLS = ["meridian-video", "cookbook-video", "direction-scripts", "motion-designer", "pixel-explainer"] as const;
export type VideoSkillName = (typeof VIDEO_SKILLS)[number];

const MAX_FILE_BYTES = 100_000;
const MAX_SKILL_BYTES = 400_000;
const TEXT_FILE = /^[A-Za-z0-9._-]+\.(md|js|json|txt)$|^LICENSE$/;

export type SkillFile = { path: string; content: string; bytes: number };
export type VideoSkill = { name: VideoSkillName; description: string; version: string; files: SkillFile[]; bytes: number };
export type SkillSummary = { name: VideoSkillName; description: string; version: string; files: string[]; bytes: number };

export function isVideoSkill(name: string): name is VideoSkillName {
  return (VIDEO_SKILLS as readonly string[]).includes(name);
}

/** Where the skills are. Under the working directory, as the Docker image keeps the repository at /app and starts the server there. */
export function skillsRoot(): string {
  return join(process.cwd(), ".claude", "skills");
}

/** The description line of a SKILL.md's front matter, or null when there is none. */
export function descriptionOf(skillMd: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd);
  if (!match) return null;
  const line = /^description:\s*(.+)$/m.exec(match[1]!);
  return line ? line[1]!.trim() : null;
}

/**
 * One skill's files, or null when it is not offered, has no SKILL.md with a description, or is too large to send. Files that are not plain
 * text, or are not directly inside the skill's folder, are left out. Nothing outside the skill's folder is read.
 */
export function readVideoSkill(name: string, root: string = skillsRoot()): VideoSkill | null {
  if (!isVideoSkill(name)) return null;
  const dir = join(root, name);
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return null;
  }
  const files: SkillFile[] = [];
  let total = 0;
  for (const entry of entries) {
    if (!TEXT_FILE.test(entry)) continue;
    const path = join(dir, entry);
    let size: number;
    try {
      const info = lstatSync(path, { throwIfNoEntry: false });
      if (!info || !info.isFile()) continue;
      size = info.size;
    } catch {
      continue;
    }
    if (size > MAX_FILE_BYTES) return null;
    total += size;
    if (total > MAX_SKILL_BYTES) return null;
    files.push({ path: entry, content: readFileSync(path, "utf8"), bytes: size });
  }
  const skillMd = files.find((file) => file.path === "SKILL.md");
  const description = skillMd ? descriptionOf(skillMd.content) : null;
  if (!skillMd || !description) return null;
  const hash = createHash("sha256");
  for (const file of files) hash.update(`${file.path}\n${file.content}\n`);
  return { name, description, version: hash.digest("hex").slice(0, 12), files, bytes: total };
}

/** The offered skills that can be read now. A skill that cannot be read is left out, and the list says nothing about it. */
export function listVideoSkills(root: string = skillsRoot()): SkillSummary[] {
  const out: SkillSummary[] = [];
  for (const name of VIDEO_SKILLS) {
    const skill = readVideoSkill(name, root);
    if (skill) out.push({ name, description: skill.description, version: skill.version, files: skill.files.map((file) => file.path), bytes: skill.bytes });
  }
  return out;
}
