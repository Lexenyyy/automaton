/**
 * Tokenizer cost bounds (ROADMAP Phase 1, tokenizer hang fix).
 *
 * js-tiktoken is quadratic on long whitespace-free runs. The token counter must
 * stay fast on such input and stay accurate on all input.
 */

import { describe, it, expect } from "vitest";
import { getEncoding } from "js-tiktoken";
import {
  createTokenCounter,
  countTokensBounded,
  MAX_RUN_CHARS,
  MAX_TOKENIZE_CHARS,
} from "../../memory/context-manager.js";
import { estimateTokens } from "../../agent/context.js";

const encoder = getEncoding("cl100k_base");

/** Generous time limit per call; measured worst case is ~170 ms at the limit. */
const FAST_MS = 2_000;

const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64Like(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += BASE64_CHARS[(i * 7919 + (i >> 3)) % 64];
  }
  return out;
}

function normalWords(length: number): string {
  const words = "the quick brown fox jumps over a lazy dog while agents pay for compute".split(" ");
  let out = "";
  let i = 0;
  while (out.length < length) out += words[i++ % words.length] + " ";
  return out.slice(0, length);
}

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

function expectWithin(actual: number, expected: number, ratio: number): void {
  expect(Math.abs(actual - expected) / expected).toBeLessThanOrEqual(ratio);
}

const ABOVE_LIMIT = MAX_TOKENIZE_CHARS * 2 + 12_345;

describe("bounded token counting", () => {
  it("uses the approved limits", () => {
    expect(MAX_RUN_CHARS).toBe(64);
    expect(MAX_TOKENIZE_CHARS).toBe(50_000);
  });

  it("is exact for normal text under the limit", () => {
    const text = normalWords(20_000);
    expect(countTokensBounded(encoder, text)).toBe(encoder.encode(text).length);
  });

  it("is fast on a long run of plain letters under the limit (used to hang)", () => {
    const text = "x".repeat(MAX_TOKENIZE_CHARS);
    const { value, ms } = timed(() => countTokensBounded(encoder, text));
    expect(ms).toBeLessThan(FAST_MS);
    // A run of "x" encodes as 8 characters per token in cl100k_base.
    const perToken = 2_048 / encoder.encode("x".repeat(2_048)).length;
    expectWithin(value, text.length / perToken, 0.1);
  }, 10_000);

  it("base64 above the limit: fast and within 10%", () => {
    const text = base64Like(ABOVE_LIMIT);
    const exact = encoder.encode(text).length;
    const { value, ms } = timed(() => countTokensBounded(encoder, text));
    expect(ms).toBeLessThan(FAST_MS);
    expectWithin(value, exact, 0.1);
  }, 10_000);

  it("plain letters above the limit: fast and within 10%", () => {
    const text = "x".repeat(ABOVE_LIMIT);
    const { value, ms } = timed(() => countTokensBounded(encoder, text));
    expect(ms).toBeLessThan(FAST_MS);
    const perToken = 2_048 / encoder.encode("x".repeat(2_048)).length;
    expectWithin(value, text.length / perToken, 0.1);
  }, 10_000);

  it("normal words above the limit: fast and within 10%", () => {
    const text = normalWords(ABOVE_LIMIT);
    const exact = encoder.encode(text).length;
    const { value, ms } = timed(() => countTokensBounded(encoder, text));
    expect(ms).toBeLessThan(FAST_MS);
    expectWithin(value, exact, 0.1);
  }, 10_000);

  it("does not split surrogate pairs inside long runs", () => {
    const text = "\u{1F600}".repeat(200); // 400 UTF-16 units, no whitespace
    expect(() => countTokensBounded(encoder, text)).not.toThrow();
    expectWithin(countTokensBounded(encoder, text), encoder.encode(text).length, 0.1);
  });
});

describe("token counter cache with large texts", () => {
  it("counts but does not cache texts over 10k chars", () => {
    const counter = createTokenCounter();
    counter.countTokens(normalWords(10_001));
    expect(counter.cache.size).toBe(0);
    counter.countTokens(normalWords(100));
    expect(counter.cache.size).toBe(1);
  });
});

describe("estimateTokens on inputs above the limit", () => {
  for (const [name, text] of [
    ["base64", base64Like(ABOVE_LIMIT)],
    ["plain letters", "x".repeat(ABOVE_LIMIT)],
    ["normal words", normalWords(ABOVE_LIMIT)],
  ] as const) {
    it(`${name}: fast and never below length/4`, () => {
      const { value, ms } = timed(() => estimateTokens(text));
      expect(ms).toBeLessThan(FAST_MS);
      expect(value).toBeGreaterThanOrEqual(Math.ceil(text.length / 4));
    }, 10_000);
  }
});
