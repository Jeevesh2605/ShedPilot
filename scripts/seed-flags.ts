/**
 * Creates the demo flags and the load-sheddable tag in Flagsmith, so setup is reproducible.
 * Safe to run again: it only creates what is missing and fixes tags that drifted.
 * It never turns a flag on or off.
 *
 *   npm run seed              # make the changes
 *   npm run seed -- --dry-run # only print what it would do
 *
 * Reads FLAGSMITH_ADMIN_API_KEY, FLAGSMITH_PROJECT_ID and FLAGSMITH_ENVIRONMENT_KEY from .env.
 */
import { existsSync } from 'node:fs';
import { FlagsmithAdmin, FlagsmithApiError, type FlagsmithFeature } from '../agent/lib/flagsmith';

const SHEDDABLE_TAG = 'load-sheddable';

const DESIRED_FLAGS = [
  { name: 'pdf_export', sheddable: true, description: 'PDF report export. CPU heavy (2 to 4 s per report).' },
  { name: 'basic_csv', sheddable: true, description: 'Small CSV export. Cheap.' },
  { name: 'rich_analytics', sheddable: true, description: 'Extra aggregation on the summary endpoint (about 1 s).' },
  { name: 'checkout_core', sheddable: false, description: 'Core checkout path. NOT sheddable: the guardrail must never turn it off.' },
];

if (existsSync('.env')) process.loadEnvFile('.env');
const dryRun = process.argv.includes('--dry-run');

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return value;
}

async function main() {
  const admin = new FlagsmithAdmin({ apiKey: requireEnv('FLAGSMITH_ADMIN_API_KEY'), host: process.env.FLAGSMITH_API_HOST });
  const projectId = Number(requireEnv('FLAGSMITH_PROJECT_ID'));
  const environmentKey = requireEnv('FLAGSMITH_ENVIRONMENT_KEY');
  console.log(dryRun ? 'DRY RUN: no changes will be made.\n' : '');

  // 1. Find the environment and report settings that affect how ShedPilot can change flags.
  const environments = await admin.listEnvironments(projectId);
  const environment = environments.find((e) => e.api_key === environmentKey);
  if (!environment) {
    console.error(`No environment with key ${environmentKey} in project ${projectId}.`);
    console.error('Environments found:', environments.map((e) => `${e.name} (${e.api_key})`).join(', '));
    process.exit(1);
  }
  console.log(`Environment: ${environment.name}, id ${environment.id}`);
  console.log(`  Feature Versioning v2: ${environment.use_v2_feature_versioning ? 'ON' : 'off'}`);
  console.log(`  Change requests:       ${environment.minimum_change_request_approvals ? 'ON (the update endpoint will refuse changes!)' : 'off'}\n`);

  // 2. Make sure the load-sheddable tag exists.
  let tag = (await admin.listTags(projectId)).find((t) => t.label === SHEDDABLE_TAG);
  if (tag) {
    console.log(`Tag "${SHEDDABLE_TAG}" exists (id ${tag.id})`);
  } else if (dryRun) {
    console.log(`Would create tag "${SHEDDABLE_TAG}"`);
  } else {
    tag = await admin.createTag(projectId, {
      label: SHEDDABLE_TAG,
      color: '#F5A623',
      description: 'ShedPilot may propose turning this flag off under load. A human still approves.',
    });
    console.log(`Created tag "${SHEDDABLE_TAG}" (id ${tag.id})`);
  }

  // 3. Create missing flags and fix tags on existing ones.
  const existing = new Map((await admin.listFeatures(projectId, environment.id)).map((f) => [f.name, f]));
  for (const flag of DESIRED_FLAGS) {
    const current = existing.get(flag.name);
    if (!current) {
      if (dryRun || !tag) {
        console.log(`Would create flag ${flag.name}${flag.sheddable ? ` tagged ${SHEDDABLE_TAG}` : ''}`);
        continue;
      }
      await admin.createFeature(projectId, {
        name: flag.name,
        description: flag.description,
        default_enabled: true,
        tags: flag.sheddable ? [tag.id] : [],
      });
      console.log(`Created flag ${flag.name}`);
      continue;
    }
    if (!tag) continue;
    const hasTag = current.tags.includes(tag.id);
    if (hasTag !== flag.sheddable) {
      const tags = flag.sheddable ? [...current.tags, tag.id] : current.tags.filter((id) => id !== tag!.id);
      if (dryRun) console.log(`Would ${flag.sheddable ? 'add' : 'remove'} tag on ${flag.name}`);
      else {
        await admin.setFeatureTags(projectId, current.id, tags);
        console.log(`${flag.sheddable ? 'Added' : 'Removed'} tag ${SHEDDABLE_TAG} on ${flag.name}`);
      }
    } else {
      console.log(`Flag ${flag.name} exists, tags OK`);
    }
  }

  // 4. Show the final state in this environment.
  const features = await admin.listFeatures(projectId, environment.id);
  const tagLabels = new Map((await admin.listTags(projectId)).map((t) => [t.id, t.label]));
  console.log('\nFlag             Enabled  Tags');
  for (const f of features.filter((f) => DESIRED_FLAGS.some((d) => d.name === f.name))) {
    const enabled = f.environment_feature_state?.enabled;
    console.log(`${f.name.padEnd(16)} ${String(enabled).padEnd(8)} ${f.tags.map((id) => tagLabels.get(id)).join(', ')}`);
    if (enabled === false) console.log(`  -> ${f.name} is off in this environment. Turn it on in the dashboard for the demo.`);
  }

  // 5. Read-only check of the endpoint the executor will use to flip flags (open question in ARCHITECTURE 2.3).
  const pdf = features.find((f) => f.name === 'pdf_export');
  if (pdf) await checkUpdateEndpoint(admin, environment.api_key, environment.id, pdf);
}

async function checkUpdateEndpoint(admin: FlagsmithAdmin, apiKey: string, numericId: number, feature: FlagsmithFeature) {
  console.log('\nChecking the flag update endpoint (read-only GET):');
  for (const [label, key] of [['environment api_key', apiKey], ['numeric environment id', String(numericId)]] as const) {
    try {
      const state = await admin.getFlagState(key, feature.id);
      console.log(`  with ${label}: OK, pdf_export enabled = ${state.environment_default.enabled}`);
    } catch (err) {
      const status = err instanceof FlagsmithApiError ? `HTTP ${err.status}` : String(err);
      console.log(`  with ${label}: failed (${status})`);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
