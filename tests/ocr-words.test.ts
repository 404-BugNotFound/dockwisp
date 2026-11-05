import assert from "node:assert/strict";
import test from "node:test";
import { repairOcrSpacing } from "../src/core/ocr-words";

test("merges a word split by a stray space", () => {
  assert.equal(
    repairOcrSpacing("rooms. Furtherm ore, books enrich our minds and im prove our critical thinking."),
    "rooms. Furthermore, books enrich our minds and improve our critical thinking.",
  );
  assert.equal(
    repairOcrSpacing("encounter great stories or com plex ideas"),
    "encounter great stories or complex ideas",
  );
});

test("splits words that ran together", () => {
  assert.equal(repairOcrSpacing("journey ofwords."), "journey of words.");
  assert.equal(repairOcrSpacing("journeyofwords."), "journey of words.");
});

test("leaves correct text and non-dictionary tokens alone", () => {
  for (const text of [
    "Reading is one of the most beneficial habits a person can develop.",
    "I am particularly fond of biographies and science fiction novels.",
    "Open Dockwisp and paste the JSON on your iPhone.",
    "Send an e-mail about the USB-C cable and COVID19 rules.",
    "Version 1.2.3 (build 456)",
    "设置 Settings",
  ]) {
    assert.equal(repairOcrSpacing(text), text);
  }
});

test("does not merge two real words", () => {
  assert.equal(repairOcrSpacing("a person"), "a person");
  assert.equal(repairOcrSpacing("in to the room"), "in to the room");
});
