/**
 * The catalog of MCP servers the Factory ships: each entry is an official MCP Registry
 * `server.json` (https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json)
 * plus a small Factory overlay — the person's-language labels, which inputs a variant shows, and
 * which inputs are filled from something the organization already has (a Google Cloud account)
 * instead of being typed. The settings form is built from these, never from field names in code.
 * Pure: parsing and form derivation only; the server reads the files and runs the servers.
 */

import { z } from 'zod';

export const MCP_REGISTRY_SERVER_SCHEMA = 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';

/** A value a person (or the Factory) provides: `server.json`'s Input / KeyValueInput. */
const registryInputSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  isRequired: z.boolean().optional(),
  isSecret: z.boolean().optional(),
  default: z.string().optional(),
  format: z.string().optional(),
  choices: z.array(z.string()).optional(),
});

/** `server.json`'s Argument: a fixed `value`, or a `valueHint` the person fills. */
const registryArgumentSchema = registryInputSchema.extend({
  type: z.enum(['positional', 'named']),
  value: z.string().optional(),
  valueHint: z.string().optional(),
  isRepeated: z.boolean().optional(),
});

const registryPackageSchema = z.object({
  registryType: z.enum(['npm', 'oci', 'nuget', 'pypi', 'cargo', 'mcpb']),
  registryBaseUrl: z.string().optional(),
  identifier: z.string().min(1),
  version: z.string().min(1),
  runtimeHint: z.string().optional(),
  transport: z.object({ type: z.enum(['stdio', 'streamable-http', 'sse']), url: z.string().optional() }),
  runtimeArguments: z.array(registryArgumentSchema).optional(),
  packageArguments: z.array(registryArgumentSchema).optional(),
  environmentVariables: z.array(registryInputSchema.extend({ name: z.string().min(1) })).optional(),
});

/** The fields of an MCP Registry `server.json` the Factory reads; unknown ones are kept as they are. */
export const mcpRegistryServerSchema = z
  .object({
    $schema: z.string().optional(),
    name: z.string().regex(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/, 'Reverse-DNS name, e.g. io.github.owner/server'),
    title: z.string().optional(),
    description: z.string().min(1),
    version: z.string().min(1),
    websiteUrl: z.string().url().optional(),
    repository: z.object({ url: z.string().url(), source: z.string() }).passthrough().optional(),
    packages: z.array(registryPackageSchema).optional(),
    remotes: z
      .array(
        z.object({
          type: z.enum(['streamable-http', 'sse']),
          url: z.string(),
          headers: z.array(registryInputSchema.extend({ name: z.string().min(1) })).optional(),
        }),
      )
      .optional(),
  })
  .passthrough();
export type McpRegistryServer = z.infer<typeof mcpRegistryServerSchema>;

const localizedSchema = z.object({ uk: z.string().min(1), en: z.string().min(1) });
export type McpLocalized = z.infer<typeof localizedSchema>;

/** Where a credential input is filled from instead of typed: an account the organization already keeps. */
export const MCP_CREDENTIAL_KINDS = ['google-cloud-account'] as const;
export type McpCredentialKind = (typeof MCP_CREDENTIAL_KINDS)[number];

/**
 * Where an input's choices come from: looked up with the account another input picked (the
 * projects that account sees; a project's Firestore databases). The form offers them and prefills
 * the obvious one; a person may still type any value.
 */
export const MCP_SUGGESTION_SOURCES = ['google-cloud-projects', 'firestore-databases'] as const;
export type McpSuggestionSource = (typeof MCP_SUGGESTION_SOURCES)[number];

/**
 * What each source's lookup needs besides the account, in order: `dependsOn` is the account input
 * followed by one input per name here, sent to the lookup under that name.
 */
export const MCP_SUGGESTION_CONTEXT: Readonly<Record<McpSuggestionSource, readonly string[]>> = {
  'google-cloud-projects': [],
  'firestore-databases': ['project'],
};

/** The lookup's context from the form's values: `{ project: <the project input's value> }`. */
export function mcpSuggestionContext(suggestion: McpSuggestion, values: Record<string, string | undefined>): Record<string, string> {
  const names = MCP_SUGGESTION_CONTEXT[suggestion.from];
  const context: Record<string, string> = {};
  names.forEach((name, index) => {
    const value = values[suggestion.dependsOn[index + 1] ?? '']?.trim();
    if (value) context[name] = value;
  });
  return context;
}

/** An input's choices: their source, and the inputs (by key) the lookup needs — the account first. */
export interface McpSuggestion {
  from: McpSuggestionSource;
  dependsOn: string[];
}

const suggestionSchema = z.object({
  from: z.enum(MCP_SUGGESTION_SOURCES),
  dependsOn: z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
    .transform(value => (Array.isArray(value) ? value : [value])),
});

/** The Factory overlay of one catalog entry: what upstream's `server.json` has no field for. */
export const mcpCatalogOverlaySchema = z.object({
  server: z.string().min(1),
  /** Stable id stored with a server, e.g. `mcp-toolbox`. */
  id: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
  label: localizedSchema,
  summary: localizedSchema,
  /**
   * The first-party integration that runs this server under the hood (`google-cloud` for MCP
   * Toolbox's Firestore). People never pick it from the catalog: they connect the integration, and
   * a server made from it shows as that integration's capability, not as an MCP server.
   */
  integration: z.enum(['google-cloud', 'clickup', 'github', 'gitlab']).optional(),
  /** The installed package's launcher, relative to the package root (npm packages run with this Node). */
  entrypoint: z.string().min(1),
  /** Ways to run the server; a person picks one (e.g. which database). Absent: one way, every input. */
  variants: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/),
        label: localizedSchema,
        summary: localizedSchema.optional(),
        /** Arguments for this variant, `${input}` filled from the inputs. */
        args: z.array(z.string()),
        /** The inputs this variant asks for, by key. */
        inputs: z.array(z.string()),
        /** Inputs required in this variant, beyond the manifest's own `isRequired`. */
        required: z.array(z.string()).default([]),
        /** Tools that write, offered as a hint to set «Заборонено» (never applied by default). */
        writeTools: z.array(z.string()).default([]),
      }),
    )
    .min(1),
  inputs: z.record(
    z.string(),
    z.object({
      label: localizedSchema,
      description: localizedSchema.optional(),
      credential: z.enum(MCP_CREDENTIAL_KINDS).optional(),
      suggest: suggestionSchema.optional(),
    }),
  ),
});
export type McpCatalogOverlay = z.infer<typeof mcpCatalogOverlaySchema>;

/** One field of the add-server form, derived from the manifest and its overlay. */
export interface McpCatalogField {
  /** Environment variable name, or an argument's `valueHint`. */
  key: string;
  /** An environment variable the server reads, or a value only its arguments use (`${key}`). */
  kind: 'env' | 'argument';
  label: McpLocalized;
  description?: McpLocalized;
  required: boolean;
  /** Stored encrypted, never shown again. */
  secret: boolean;
  /** Written to a private temp file whose path the server gets (a key file, a tools file). */
  file: boolean;
  default?: string;
  choices?: string[];
  credential?: McpCredentialKind;
  suggest?: McpSuggestion;
}

export interface McpCatalogVariant {
  id: string;
  label: McpLocalized;
  summary?: McpLocalized;
  args: string[];
  fields: McpCatalogField[];
  writeTools: string[];
}

/** A catalog entry as the settings page and the launcher use it. */
export interface McpCatalogEntry {
  id: string;
  server: string;
  label: McpLocalized;
  summary: McpLocalized;
  websiteUrl?: string;
  /** Run under the hood by this first-party integration; hidden from the catalog people pick from. */
  integration?: 'google-cloud' | 'clickup' | 'github' | 'gitlab';
  package: { registryType: string; identifier: string; version: string; entrypoint: string };
  variants: McpCatalogVariant[];
}

/** A broken catalog file is a build defect: it fails loudly at load, never shows a half form. */
export class McpCatalogError extends Error {
  override name = 'McpCatalogError';
}

type RegistryInput = z.infer<typeof registryInputSchema>;

/** Builds a catalog entry from a `server.json` and its Factory overlay. */
export function mcpCatalogEntry(manifest: unknown, overlay: unknown): McpCatalogEntry {
  const server = mcpRegistryServerSchema.safeParse(manifest);
  if (!server.success) throw new McpCatalogError(`Invalid server.json: ${server.error.message}`);
  const extra = mcpCatalogOverlaySchema.safeParse(overlay);
  if (!extra.success) throw new McpCatalogError(`Invalid overlay for ${server.data.name}: ${extra.error.message}`);
  if (extra.data.server !== server.data.name) {
    throw new McpCatalogError(`Overlay is for ${extra.data.server}, not ${server.data.name}.`);
  }
  const pkg = server.data.packages?.find(candidate => candidate.registryType === 'npm' && candidate.transport.type === 'stdio');
  if (!pkg) throw new McpCatalogError(`${server.data.name} has no npm stdio package the Factory can run.`);

  const declared = new Map<string, { input: RegistryInput; kind: 'env' | 'argument' }>();
  for (const variable of pkg.environmentVariables ?? []) declared.set(variable.name, { input: variable, kind: 'env' });
  for (const argument of pkg.packageArguments ?? []) {
    if (argument.value === undefined && argument.valueHint) declared.set(argument.valueHint, { input: argument, kind: 'argument' });
  }

  const variants = extra.data.variants.map(variant => ({
    id: variant.id,
    label: variant.label,
    ...(variant.summary ? { summary: variant.summary } : {}),
    args: variant.args,
    writeTools: variant.writeTools,
    fields: variant.inputs.map((key): McpCatalogField => {
      const found = declared.get(key);
      if (!found) throw new McpCatalogError(`${server.data.name} variant ${variant.id} asks for ${key}, which server.json does not declare.`);
      const text = extra.data.inputs[key];
      if (!text) throw new McpCatalogError(`${server.data.name}: input ${key} has no label in the overlay.`);
      const { input, kind } = found;
      if (text.suggest) {
        for (const dependency of text.suggest.dependsOn) {
          if (!variant.inputs.includes(dependency)) {
            throw new McpCatalogError(`${server.data.name} variant ${variant.id}: ${key} suggests from ${dependency}, which this variant does not ask for.`);
          }
        }
        const expected = 1 + MCP_SUGGESTION_CONTEXT[text.suggest.from].length;
        if (text.suggest.dependsOn.length !== expected) {
          throw new McpCatalogError(`${server.data.name}: ${key} (${text.suggest.from}) depends on ${expected} inputs: the account, then ${MCP_SUGGESTION_CONTEXT[text.suggest.from].join(', ') || 'nothing else'}.`);
        }
        if (!extra.data.inputs[text.suggest.dependsOn[0]!]?.credential) {
          throw new McpCatalogError(`${server.data.name}: ${key} must depend first on an account input.`);
        }
      }
      return {
        key,
        kind,
        label: text.label,
        ...(text.description ? { description: text.description } : {}),
        required: Boolean(input.isRequired) || variant.required.includes(key),
        secret: Boolean(input.isSecret),
        file: input.format === 'filepath',
        ...(input.default !== undefined ? { default: input.default } : {}),
        ...(input.choices ? { choices: input.choices } : {}),
        ...(text.credential ? { credential: text.credential } : {}),
        ...(text.suggest ? { suggest: text.suggest } : {}),
      };
    }),
  }));

  return {
    id: extra.data.id,
    server: server.data.name,
    label: extra.data.label,
    summary: extra.data.summary,
    ...(server.data.websiteUrl ? { websiteUrl: server.data.websiteUrl } : {}),
    ...(extra.data.integration ? { integration: extra.data.integration } : {}),
    package: { registryType: pkg.registryType, identifier: pkg.identifier, version: pkg.version, entrypoint: extra.data.entrypoint },
    variants,
  };
}

/** The variant a stored server runs: the named one, or the only one. */
export function mcpCatalogVariant(entry: McpCatalogEntry, variantId: string | undefined): McpCatalogVariant | undefined {
  return variantId ? entry.variants.find(variant => variant.id === variantId) : entry.variants.length === 1 ? entry.variants[0] : undefined;
}

/** A server's identifier from its name: lowercase latin, digits and dashes (Ukrainian transliterated). */
export function mcpServerSlug(label: string): string {
  const map: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i',
    к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch',
    ш: 'sh', щ: 'shch', ь: '', ю: 'iu', я: 'ia', ы: 'y', э: 'e', ё: 'io', ъ: '',
  };
  const latin = [...label.toLowerCase()].map(char => map[char] ?? char).join('');
  const slug = latin.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '').slice(0, 31).replace(/-+$/, '');
  return slug.length >= 2 ? slug : `mcp-${slug || 'server'}`.slice(0, 31);
}

/** A slug not already taken: `name`, `name-2`, `name-3`… */
export function uniqueMcpServerSlug(label: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = mcpServerSlug(label);
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base.slice(0, 31 - String(n).length - 1)}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}
