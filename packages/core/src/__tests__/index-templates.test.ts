import { describe, it, expect } from "vitest";
import {
  canonicalizeCollectionPathToTemplate,
  indexCollectionPathCovers,
  isTemplateCollectionPath,
  parseIndexCollectionPath,
} from "../index-templates.js";

describe("@vellum/core index collection-path templates", () => {
  it("canonicalizes nested concrete paths by replacing document-id segments", () => {
    expect(canonicalizeCollectionPathToTemplate("chats/chat_123/messages")).toBe("chats/*/messages");
    expect(canonicalizeCollectionPathToTemplate("a/1/b/2/c")).toBe("a/*/b/*/c");
  });

  it("leaves root collections and existing templates unchanged", () => {
    expect(canonicalizeCollectionPathToTemplate("messages")).toBe("messages");
    expect(canonicalizeCollectionPathToTemplate("chats/*/messages")).toBe("chats/*/messages");
  });

  it("detects templates only when a document-id segment is exactly *", () => {
    expect(isTemplateCollectionPath("chats/*/messages")).toBe(true);
    expect(isTemplateCollectionPath("chats/chat_1/messages")).toBe(false);
    expect(isTemplateCollectionPath("posts")).toBe(false);
    expect(isTemplateCollectionPath("chats/ab*cd/messages")).toBe(false);
  });

  it("matches concrete index records with exact semantics only", () => {
    expect(indexCollectionPathCovers("chats/chat_1/messages", "chats/chat_1/messages")).toBe(true);
    expect(indexCollectionPathCovers("chats/chat_1/messages", "chats/chat_2/messages")).toBe(false);
  });

  it("matches templates segment-wise, one segment per wildcard", () => {
    expect(indexCollectionPathCovers("chats/*/messages", "chats/chat_9/messages")).toBe(true);
    expect(indexCollectionPathCovers("chats/*/messages", "chats/chat_9/files")).toBe(false);
    expect(indexCollectionPathCovers("chats/*/messages", "chats/chat_9/messages/x/y")).toBe(false);
    expect(indexCollectionPathCovers("chats/*/messages", "chats")).toBe(false);
    expect(indexCollectionPathCovers("a/*/b/*/c", "a/1/b/2/c")).toBe(true);
    expect(indexCollectionPathCovers("a/*/b/*/c", "a/1/x/2/c")).toBe(false);
  });

  it("accepts concrete paths and well-formed templates", () => {
    expect(() => parseIndexCollectionPath("posts")).not.toThrow();
    expect(() => parseIndexCollectionPath("chats/*/messages")).not.toThrow();
    expect(() => parseIndexCollectionPath("a/*/b/*/c")).not.toThrow();
  });

  it("rejects wildcards at collection positions or inside larger segments", () => {
    expect(() => parseIndexCollectionPath("*/chat_1/messages")).toThrow();
    expect(() => parseIndexCollectionPath("chats/ab*cd/messages")).toThrow();
    expect(() => parseIndexCollectionPath("chats/*/messages/*/deep/x*")).toThrow();
    expect(() => parseIndexCollectionPath("chats/*/messages/*/extra")).not.toThrow(); // two document-id wildcards are fine
  });

  it("rejects structurally invalid paths", () => {
    expect(() => parseIndexCollectionPath("")).toThrow();
    expect(() => parseIndexCollectionPath("/chats/*/messages")).toThrow();
    expect(() => parseIndexCollectionPath("chats//messages")).toThrow();
  });
});
