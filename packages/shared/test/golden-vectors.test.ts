/**
 * Golden vectors.
 *
 * These assert against `vectors/golden.json`, a committed file whose expected
 * values were produced once by the implementation and then frozen. The point is
 * not to re-derive them but to *lock* them: any change to the schema, the
 * unordered-field set, the normalisation rules or the encoder will break these
 * tests, forcing an explicit decision rather than a silent protocol change.
 *
 * If a test here fails, the correct response is almost never to regenerate the
 * file. It is to ask whether the protocol was meant to change, and if so, to
 * bump the specification version.
 *
 * The same JSON file is consumed by the Solidity tests in Milestone 2 and by
 * deployment verification tooling, so a reimplementation in any language can be
 * checked against it.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  buildEvidenceCommitment,
  buildRulesCommitment,
  CONDITION_SPEC_VERSION,
  CURRENT_EVIDENCE_PACKAGE_VERSION,
  EVIDENCE_PACKAGE_VERSION_1,
  SUPPORTED_EVIDENCE_PACKAGE_VERSIONS,
  UNORDERED_FIELDS,
} from '../src/index.js';

interface ConditionSpecVector {
  readonly name: string;
  readonly input: unknown;
  readonly canonical: string;
  readonly rulesHash: string;
}

interface EvidencePackageVector {
  readonly name: string;
  readonly input: unknown;
  readonly canonical: string;
  readonly evidenceHash: string;
}

interface GoldenVectorFile {
  readonly producer: string;
  readonly conditionSpecVersion: string;
  readonly evidencePackageVersion: string;
  readonly evidencePackageVersions: readonly string[];
  readonly currentEvidencePackageVersion: string;
  readonly algorithm: {
    readonly digest: string;
    readonly encoding: string;
    readonly unorderedFields: {
      readonly conditionSpec: readonly string[];
      readonly evidencePackage: readonly string[];
      readonly evidencePackageV2: readonly string[];
    };
  };
  readonly conditionSpecs: readonly ConditionSpecVector[];
  readonly evidencePackages: readonly EvidencePackageVector[];
}

const vectorsPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'vectors',
  'golden.json',
);

const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8')) as GoldenVectorFile;

describe('vector file integrity', () => {
  it('declares the versions this build produces', () => {
    expect(vectors.conditionSpecVersion).toBe(CONDITION_SPEC_VERSION);
    expect(vectors.currentEvidencePackageVersion).toBe(CURRENT_EVIDENCE_PACKAGE_VERSION);
  });

  it('declares every evidence package version this build still accepts', () => {
    expect(vectors.evidencePackageVersions).toEqual([...SUPPORTED_EVIDENCE_PACKAGE_VERSIONS]);
  });

  it('keeps the frozen v1.0 marker unchanged', () => {
    // The scalar field predates v2.0 and named the only version there was. It
    // stays pinned to v1.0 rather than following the current version, so an old
    // consumer reading it is not silently handed a schema it cannot parse.
    expect(vectors.evidencePackageVersion).toBe(EVIDENCE_PACKAGE_VERSION_1);
  });

  it('declares the digest and encoding the protocol uses', () => {
    expect(vectors.algorithm.digest).toContain('keccak256');
    expect(vectors.algorithm.encoding).toBe('UTF-8');
  });

  it('declares the same unordered-field set the implementation applies', () => {
    expect(vectors.algorithm.unorderedFields.conditionSpec).toEqual([
      ...UNORDERED_FIELDS.conditionSpec,
    ]);
    expect(vectors.algorithm.unorderedFields.evidencePackage).toEqual([
      ...UNORDERED_FIELDS.evidencePackage,
    ]);
    expect(vectors.algorithm.unorderedFields.evidencePackageV2).toEqual([
      ...UNORDERED_FIELDS.evidencePackageV2,
    ]);
  });

  it('covers every shipped fixture', () => {
    expect(vectors.conditionSpecs.map((vector) => vector.name)).toEqual([
      'shipment',
      'productLaunch',
      'minimal',
    ]);
    expect(vectors.evidencePackages.map((vector) => vector.name)).toEqual([
      'delivered',
      'unreachableSource',
      'v2ShipmentYes',
      'v2ShipmentNo',
      'v2MultiSource',
      'v2MultiClaim',
      'v2CheckVocabulary',
      'v2Invalid',
      'v2LowConfidence',
      'v2OtherRules',
      'v2SourceOrderSwapped',
      'v2ClaimEdited',
    ]);
  });

  /**
   * The whole point of adding a version rather than editing one. If v2.0 had
   * reached back into shared code that v1.0 depends on, this is what would have
   * caught it — the two frozen digests are the same ones Milestone 1 committed
   * and Milestone 2's Solidity tests assert against.
   */
  it('leaves the two v1.0 vectors first and frozen', () => {
    const [delivered, unreachable] = vectors.evidencePackages;
    expect(delivered?.name).toBe('delivered');
    expect(delivered?.evidenceHash).toBe(
      '0x2c8cb84a1b1367090334c08e748312c3222cb5fbc456264b7bf1a8ff2525c6d8',
    );
    expect(unreachable?.name).toBe('unreachableSource');
    expect(unreachable?.evidenceHash).toBe(
      '0x4d33645167e3df2f489a9f7bac54bdc630535b30f740e096dbcdaa2ffeb3bb20',
    );
  });

  it('assigns a distinct hash to each evidence vector', () => {
    const hashes = vectors.evidencePackages.map((vector) => vector.evidenceHash);
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});

describe('condition specification vectors', () => {
  for (const vector of vectors.conditionSpecs) {
    describe(vector.name, () => {
      it('produces the locked canonical representation, byte for byte', () => {
        expect(buildRulesCommitment(vector.input).canonical).toBe(vector.canonical);
      });

      it('produces the locked rulesHash', () => {
        expect(buildRulesCommitment(vector.input).rulesHash).toBe(vector.rulesHash);
      });

      it('has a locked hash that is a well-formed bytes32', () => {
        expect(vector.rulesHash).toMatch(/^0x[0-9a-f]{64}$/);
      });

      it('re-hashes identically from its own canonical form', () => {
        const { canonical, rulesHash } = buildRulesCommitment(vector.input);
        expect(buildRulesCommitment(JSON.parse(canonical)).rulesHash).toBe(rulesHash);
      });
    });
  }

  it('assigns a distinct hash to each vector', () => {
    const hashes = vectors.conditionSpecs.map((vector) => vector.rulesHash);
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});

describe('evidence package vectors', () => {
  for (const vector of vectors.evidencePackages) {
    describe(vector.name, () => {
      it('produces the locked canonical representation, byte for byte', () => {
        expect(buildEvidenceCommitment(vector.input).canonical).toBe(vector.canonical);
      });

      it('produces the locked evidenceHash', () => {
        expect(buildEvidenceCommitment(vector.input).evidenceHash).toBe(vector.evidenceHash);
      });

      it('has a locked hash that is a well-formed bytes32', () => {
        expect(vector.evidenceHash).toMatch(/^0x[0-9a-f]{64}$/);
      });

      it('re-hashes identically from its own canonical form', () => {
        const { canonical, evidenceHash } = buildEvidenceCommitment(vector.input);
        expect(buildEvidenceCommitment(JSON.parse(canonical)).evidenceHash).toBe(evidenceHash);
      });
    });
  }
});

/**
 * Replace every JSON string literal with `""`, leaving only the structural
 * skeleton. Whitespace inside a string value is meaningful content; whitespace
 * anywhere else would be the insignificant whitespace RFC 8785 forbids, and the
 * two cannot be told apart without stripping the literals first.
 */
function structuralSkeleton(canonical: string): string {
  return canonical.replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

describe('canonical form properties', () => {
  it('contains no insignificant whitespace outside string values', () => {
    for (const vector of [...vectors.conditionSpecs, ...vectors.evidencePackages]) {
      expect(structuralSkeleton(vector.canonical)).not.toMatch(/\s/);
    }
  });

  it('keeps whitespace that is part of a string value', () => {
    const shipment = vectors.conditionSpecs.find((vector) => vector.name === 'shipment');
    expect(shipment?.canonical).toContain('Will shipment 1Z999AA10123456784 be delivered');
  });

  it('begins each document with the alphabetically first key', () => {
    for (const vector of vectors.conditionSpecs) {
      expect(vector.canonical.startsWith('{"ambiguities":')).toBe(true);
    }
    for (const vector of vectors.evidencePackages) {
      expect(vector.canonical.startsWith('{"chainId":')).toBe(true);
    }
  });
});
