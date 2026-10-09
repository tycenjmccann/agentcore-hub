/**
 * TEAM-5101 — resolveChildIssueType, the one rule for "which issue type may live
 * under this parent". The create path through the handler is covered in
 * index.test.mjs against a Jira double that enforces the hierarchy.
 *
 * Uses only Node's built-in runner, like the rest of this directory.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { resolveChildIssueType } from "./index.mjs";

const EPIC = { name: "Epic", subtask: false, hierarchyLevel: 1 };
const BUG = { name: "Bug", subtask: false, hierarchyLevel: 0 };
const STORY = { name: "Story", subtask: false, hierarchyLevel: 0 };
const TASK = { name: "Task", subtask: false, hierarchyLevel: 0 };
const SUBTASK = { name: "Subtask", subtask: true, hierarchyLevel: -1 };

test("an Epic parent takes a Task, never a Subtask", () => {
  assert.equal(resolveChildIssueType("Task", EPIC), "Task");
  assert.equal(resolveChildIssueType("Subtask", EPIC), "Task");
  // Named "epic" with no hierarchyLevel (older payloads), and a level-1 type by another name.
  assert.equal(resolveChildIssueType("Subtask", { name: "epic" }), "Task");
  assert.equal(resolveChildIssueType("Subtask", { name: "Initiative", hierarchyLevel: 1 }), "Task");
});

test("a standard parent (Bug / Story / Task) takes a Subtask", () => {
  for (const parent of [BUG, STORY, TASK, { name: "Bug" }]) {
    assert.equal(resolveChildIssueType("Task", parent), "Subtask", parent.name);
    assert.equal(resolveChildIssueType("Subtask", parent), "Subtask", parent.name);
  }
});

test("an unknown parent: Subtask -> Task (an orphan is worse), Task stays Task", () => {
  for (const unknown of [null, undefined]) {
    assert.equal(resolveChildIssueType("Subtask", unknown), "Task");
    assert.equal(resolveChildIssueType("Task", unknown), "Task");
  }
  // An answer that names no type is no answer.
  assert.equal(resolveChildIssueType("Task", {}), "Task");
});

test("anything else is returned unchanged", () => {
  assert.equal(resolveChildIssueType("Story", BUG), "Story");
  assert.equal(resolveChildIssueType("Bug", EPIC), "Bug");
  assert.equal(resolveChildIssueType("Epic", null), "Epic");
  // A subtask cannot parent anything; the resolver does not invent a type for it.
  assert.equal(resolveChildIssueType("Task", SUBTASK), "Task");
});
