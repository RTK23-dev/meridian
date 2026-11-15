import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { availableChoices, descriptionOf, isSkillChoice, SKILL_CHOICES, isVideoSkill, listVideoSkills, readVideoSkill, VIDEO_SKILLS } from "./skills.ts";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "skills-"));
  mkdirSync(join(root, "cookbook-video"));
  writeFileSync(join(root, "cookbook-video", "SKILL.md"), "---\nname: cookbook-video\ndescription: Make a short video.\n---\n# Body\n");
  writeFileSync(join(root, "cookbook-video", "notes.md"), "extra");
  writeFileSync(join(root, "cookbook-video", "binary.png"), "not text");
  writeFileSync(join(root, "cookbook-video", ".hidden"), "hidden");
  mkdirSync(join(root, "engine-bible"));
  writeFileSync(join(root, "engine-bible", "SKILL.md"), "---\ndescription: engine rules\n---\n");
  return root;
}

describe("the video skills Meridian offers", () => {
  it("offers only the video skills, never the engine's own rules", () => {
    assert.equal(isVideoSkill("engine-bible"), false);
    assert.equal(isVideoSkill("cookbook-video"), true);
    assert.equal(readVideoSkill("engine-bible", fixture()), null);
    assert.equal(readVideoSkill("../etc", fixture()), null);
  });

  it("reads a skill's plain-text files and its description, and leaves out other files", () => {
    const skill = readVideoSkill("cookbook-video", fixture());
    assert.ok(skill);
    assert.equal(skill.description, "Make a short video.");
    assert.deepEqual(skill.files.map((file) => file.path), ["SKILL.md", "notes.md"]);
    assert.match(skill.version, /^[0-9a-f]{12}$/);
  });

  it("changes the version when a file changes, and not otherwise", () => {
    const root = fixture();
    const first = readVideoSkill("cookbook-video", root)!.version;
    assert.equal(readVideoSkill("cookbook-video", root)!.version, first);
    writeFileSync(join(root, "cookbook-video", "notes.md"), "changed");
    assert.notEqual(readVideoSkill("cookbook-video", root)!.version, first);
  });

  it("is null for a skill with no description, a missing folder, a file that is too large, or a symlink", () => {
    const root = fixture();
    mkdirSync(join(root, "pixel-explainer"));
    writeFileSync(join(root, "pixel-explainer", "SKILL.md"), "# no front matter\n");
    assert.equal(readVideoSkill("pixel-explainer", root), null);
    assert.equal(readVideoSkill("motion-designer", root), null);
    writeFileSync(join(root, "cookbook-video", "big.md"), "x".repeat(100_001));
    assert.equal(readVideoSkill("cookbook-video", root), null);
    const other = fixture();
    writeFileSync(join(other, "secret.md"), "secret");
    symlinkSync(join(other, "secret.md"), join(other, "cookbook-video", "link.md"));
    assert.deepEqual(readVideoSkill("cookbook-video", other)!.files.map((file) => file.path), ["SKILL.md", "notes.md"]);
  });

  it("lists the skills it can read and leaves out the rest", () => {
    assert.deepEqual(listVideoSkills(fixture()).map((skill) => skill.name), ["cookbook-video"]);
  });

  it("ships every offered skill from the repository, each readable", () => {
    const listed = listVideoSkills().map((skill) => skill.name);
    assert.deepEqual(listed, [...VIDEO_SKILLS]);
  });

  it("reads a description from front matter only", () => {
    assert.equal(descriptionOf("---\ndescription: One line.\n---\nbody"), "One line.");
    assert.equal(descriptionOf("description: not in front matter"), null);
  });

  it("offers a choice only when its skill can be read, and every choice names an offered skill", () => {
    assert.deepEqual(availableChoices(fixture()).map((choice) => choice.id), ["cookbook"]);
    for (const choice of SKILL_CHOICES) assert.ok(isVideoSkill(choice.skill), choice.id);
    assert.equal(isSkillChoice("auto"), true);
    assert.equal(isSkillChoice("motion-designer"), false);
    assert.deepEqual(availableChoices().map((choice) => choice.id), SKILL_CHOICES.map((choice) => choice.id));
  });
});
