// ISVD-606. Which backend a pod uses, and the one case where the default is not
// the answer.
//
// This is the safety-critical half of the change. Every lab already deployed has
// its cameras, prompt-sets and scenarios in Firestore, and the ordinary way to
// ship a new console build to one is `kubectl set image` — which does not touch
// the ConfigMap. A flat default of `file` would bring that pod up on an empty YAML
// document: no cameras, no error, and a reconciler converging the cluster onto
// nothing. Nothing in the schema or the type system prevents that; this does.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { createRequire } from "module";
import {
  configStoreKind,
  storeKindWasInferred,
  ConfigStoreSelectionError,
  STORE_KINDS,
} from "@/lib/config-store";

const ROOT = path.resolve(__dirname, "../..");

describe("configStoreKind", () => {
  it("defaults to the file store when nothing is configured", () => {
    expect(configStoreKind({})).toBe("file");
  });

  it("honours an explicit selection", () => {
    expect(configStoreKind({ CONSOLE_CONFIG_STORE: "file" })).toBe("file");
    expect(configStoreKind({ CONSOLE_CONFIG_STORE: "firestore" })).toBe("firestore");
  });

  it("is case- and whitespace-insensitive on the explicit value", () => {
    // A ConfigMap value edited by hand picks up both.
    expect(configStoreKind({ CONSOLE_CONFIG_STORE: " Firestore " })).toBe("firestore");
    expect(configStoreKind({ CONSOLE_CONFIG_STORE: "FILE" })).toBe("file");
  });

  it("infers firestore when a project is set but no backend was chosen", () => {
    // The `kubectl set image` case: an existing lab's ConfigMap carries
    // FIRESTORE_PROJECT_ID and no CONSOLE_CONFIG_STORE.
    expect(configStoreKind({ FIRESTORE_PROJECT_ID: "isv-alliances" })).toBe("firestore");
    expect(storeKindWasInferred({ FIRESTORE_PROJECT_ID: "isv-alliances" })).toBe(true);
  });

  it("lets an explicit file selection override an inherited project id", () => {
    // This is how a lab is migrated: keep FIRESTORE_PROJECT_ID (so the migration
    // script can still read the old store) and set the backend explicitly.
    const env = { CONSOLE_CONFIG_STORE: "file", FIRESTORE_PROJECT_ID: "isv-alliances" };
    expect(configStoreKind(env)).toBe("file");
    expect(storeKindWasInferred(env)).toBe(false);
  });

  it("does not infer from GOOGLE_CLOUD_PROJECT", () => {
    // Ambient on GCP infrastructure, so it says nothing about what anyone chose.
    // firestoreProjectId() still accepts it as a project id once the backend is
    // selected — a different question.
    expect(configStoreKind({ GOOGLE_CLOUD_PROJECT: "some-project" })).toBe("file");
  });

  it("treats a blank project id as unset", () => {
    // `FIRESTORE_PROJECT_ID: ""` is exactly what k8s/11-configmap-env.yaml ships
    // as its placeholder, so a template that nobody filled in must not select a
    // backend that cannot work.
    expect(configStoreKind({ FIRESTORE_PROJECT_ID: "" })).toBe("file");
    expect(configStoreKind({ FIRESTORE_PROJECT_ID: "   " })).toBe("file");
  });

  it("treats a blank explicit value as unset rather than as an error", () => {
    expect(configStoreKind({ CONSOLE_CONFIG_STORE: "" })).toBe("file");
    expect(configStoreKind({ CONSOLE_CONFIG_STORE: "  ", FIRESTORE_PROJECT_ID: "p" })).toBe("firestore");
  });

  it("refuses a backend it does not know instead of falling back", () => {
    // A typo must not silently land on the default: the writes would go somewhere
    // the operator did not choose, which is the failure this whole module guards.
    expect(() => configStoreKind({ CONSOLE_CONFIG_STORE: "firestor" })).toThrow(
      ConfigStoreSelectionError,
    );
    expect(() => configStoreKind({ CONSOLE_CONFIG_STORE: "postgres" })).toThrow(/not a known backend/);
  });

  it("names every backend it accepts in the error", () => {
    let msg = "";
    try {
      configStoreKind({ CONSOLE_CONFIG_STORE: "nope" });
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    for (const kind of STORE_KINDS) expect(msg).toContain(kind);
  });
});

// Same three-resolver problem as the telemetry opt-in, and the same shape of
// test — see tests/unit/telemetry-optional.test.ts. Getting it wrong fails only
// on a machine without the SDK, never on the author's.
describe("the optional Firestore SDK", () => {
  const req = createRequire(import.meta.url);
  const optional = req(path.join(ROOT, "firestore-optional.cjs")) as {
    PACKAGE: string;
    VERSION: string;
    NOOP_MODULE: string;
    firestoreInstalled: () => boolean;
  };
  const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

  it("appears in no dependency field of package.json", () => {
    // The opt-in is a property of an install, not of the source. Reinstated as a
    // dependency, a default clone pulls a GCP client library, gRPC and protobufjs
    // for code paths the default backend never reaches — measured: 208 packages,
    // 133 → 49 in the production tree.
    const pkg = JSON.parse(read("package.json"));
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      expect(
        Object.keys(pkg[field] ?? {}),
        `${optional.PACKAGE} must not be in ${field}`,
      ).not.toContain(optional.PACKAGE);
    }
  });

  it("pins an exact version, because --no-save writes no lockfile entry", () => {
    expect(optional.VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("next.config.js and vitest.config.ts both read firestore-optional.cjs", () => {
    for (const cfg of ["next.config.js", "vitest.config.ts"]) {
      expect(read(cfg), `${cfg} must not decide presence for itself`).toContain(
        "firestore-optional.cjs",
      );
    }
  });

  it("neither config hardcodes the package name or the stub path", () => {
    for (const cfg of ["next.config.js", "vitest.config.ts"]) {
      const src = read(cfg);
      const quoted = src.match(/["']@google-cloud\/firestore["']/g) ?? [];
      expect(quoted, `${cfg} hardcodes the package name`).toHaveLength(0);
      expect(src, `${cfg} hardcodes the stub path`).not.toContain("firestore-absent.ts\"");
    }
  });

  it("the stub module the check names actually exists, and refuses", () => {
    const stub = read(optional.NOOP_MODULE);
    // Unlike the telemetry stand-in, this one must throw. A config store that
    // accepted writes and dropped them would lose an operator's camera
    // configuration with no error anywhere.
    expect(stub).toMatch(/throw new Error/);
    expect(stub).toContain("enable-firestore");
  });

  it("only the store module names the package in src/", () => {
    // Every other caller goes through makeConfigStore, so absence is one
    // resolution problem rather than several.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of req("fs").readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name)) {
          const rel = path.relative(ROOT, p);
          if (rel === path.join("src", "lib", "config-store", "firestore.ts")) continue;
          if (readFileSync(p, "utf8").includes(`"${optional.PACKAGE}"`)) offenders.push(rel);
        }
      }
    };
    walk(path.join(ROOT, "src"));
    expect(offenders, "import from @/lib/config-store instead").toEqual([]);
  });
});
