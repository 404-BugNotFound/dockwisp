import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

interface StoredDocument {
  _id: string;
  _rev: string;
  [key: string]: unknown;
}

interface StoreData {
  kv: Record<string, unknown>;
  docs: Record<string, StoredDocument>;
}

function safePluginDirectory(root: string, pluginId: string): string {
  const name = createHash("sha256").update(pluginId).digest("hex").slice(0, 24);
  return path.join(root, name);
}

export class PluginStore {
  private readonly filePath: string;
  private data: StoreData;

  constructor(root: string, pluginId: string) {
    const directory = safePluginDirectory(root, pluginId);
    mkdirSync(directory, { recursive: true });
    this.filePath = path.join(directory, "data.json");
    this.data = this.read();
  }

  getItem(key: string): unknown {
    return structuredClone(this.data.kv[key]);
  }

  setItem(key: string, value: unknown): void {
    this.data.kv[key] = structuredClone(value);
    this.write();
  }

  removeItem(key: string): void {
    delete this.data.kv[key];
    this.write();
  }

  put(document: Record<string, unknown>): { ok: true; id: string; rev: string } {
    if (typeof document._id !== "string" || !document._id) throw new Error("文档缺少 _id");
    const current = this.data.docs[document._id];
    if (current && document._rev !== current._rev) throw new Error("document update conflict");
    const generation = current ? Number.parseInt(current._rev.split("-")[0], 10) + 1 : 1;
    const digest = createHash("sha1")
      .update(JSON.stringify(document))
      .update(String(Date.now()))
      .digest("hex")
      .slice(0, 12);
    const stored = structuredClone(document) as StoredDocument;
    stored._rev = `${generation}-${digest}`;
    this.data.docs[stored._id] = stored;
    this.write();
    return { ok: true, id: stored._id, rev: stored._rev };
  }

  get(id: string): StoredDocument | null {
    const document = this.data.docs[id];
    return document ? structuredClone(document) : null;
  }

  remove(documentOrId: string | Record<string, unknown>): { ok: true; id: string } {
    const id =
      typeof documentOrId === "string" ? documentOrId : String(documentOrId._id ?? "");
    if (!id || !this.data.docs[id]) throw new Error("missing document");
    delete this.data.docs[id];
    this.write();
    return { ok: true, id };
  }

  bulkDocs(documents: Record<string, unknown>[]): unknown[] {
    return documents.map((document) => this.put(document));
  }

  allDocs(options: { include_docs?: boolean } = {}): {
    total_rows: number;
    rows: Array<{ id: string; key: string; value: { rev: string }; doc?: StoredDocument }>;
  } {
    const documents = Object.values(this.data.docs).sort((left, right) =>
      left._id.localeCompare(right._id),
    );
    return {
      total_rows: documents.length,
      rows: documents.map((document) => ({
        id: document._id,
        key: document._id,
        value: { rev: document._rev },
        ...(options.include_docs ? { doc: structuredClone(document) } : {}),
      })),
    };
  }

  private read(): StoreData {
    if (!existsSync(this.filePath)) return { kv: {}, docs: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<StoreData>;
      return { kv: parsed.kv ?? {}, docs: parsed.docs ?? {} };
    } catch {
      return { kv: {}, docs: {} };
    }
  }

  private write(): void {
    const temporary = `${this.filePath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
    renameSync(temporary, this.filePath);
  }
}
