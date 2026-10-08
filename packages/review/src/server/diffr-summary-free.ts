import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { parse, stringify } from "smol-toml";
import { z } from "zod";

const execFileAsync = promisify(execFile);

/**
 * The environment a read-only viewer's comparison runs diffr in: the user's
 * own diffr settings, with the LLM summarizer off (and its key left out) and
 * external plugins dropped, so a viewer never spends this machine's keys or
 * reaches the network through diffr. diffr reads settings only from
 * $XDG_CONFIG_HOME/diffr, so they go in a private directory that also links
 * the user's Git settings, global ignores included. Dispose removes it.
 */
export async function summaryFreeDiffrEnvironment(
  executable: string,
  repositoryPath: string,
): Promise<{ env: NodeJS.ProcessEnv; dispose: () => Promise<void> }> {
  const settings = withoutSummaries(
    await userSettings(executable, repositoryPath),
  );

  const home = await mkdtemp(join(tmpdir(), "review-diffr-viewer-"));
  const dispose = () => rm(home, { recursive: true, force: true });

  try {
    await mkdir(join(home, "diffr"), { mode: 0o700 });
    await writeFile(join(home, "diffr", "config.toml"), stringify(settings), {
      mode: 0o600,
    });

    const git = join(
      process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
      "git",
    );

    if (existsSync(git)) await symlink(git, join(home, "git"));
  } catch (error) {
    await dispose();
    throw error;
  }

  return { env: { ...process.env, XDG_CONFIG_HOME: home }, dispose };
}

/** The parts of diffr's settings a viewer's run changes; the rest passes through. */
const diffrSettingsSchema = z.looseObject({
  plugins: z
    .looseObject({
      order: z.array(z.string()).optional(),
      bundled: z
        .looseObject({ summarize: z.looseObject({}).optional() })
        .optional(),
      external: z.unknown().optional(),
    })
    .optional(),
});

type DiffrSettings = z.infer<typeof diffrSettingsSchema>;

/** The resolved settings; diffr's defaults (summaries off) when it cannot say. */
async function userSettings(
  executable: string,
  repositoryPath: string,
): Promise<DiffrSettings> {
  try {
    const { stdout } = await execFileAsync(executable, ["config", "show"], {
      cwd: repositoryPath,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30_000,
    });

    return diffrSettingsSchema.parse(parse(stdout));
  } catch {
    return { version: 1 };
  }
}

function withoutSummaries(settings: DiffrSettings): DiffrSettings {
  const {
    external: _external,
    order,
    bundled,
    ...plugins
  } = settings.plugins ?? {};

  const { api_key: _key, ...summarize } = bundled?.summarize ?? {};

  return {
    ...settings,
    plugins: {
      ...plugins,
      ...(order && { order: order.filter((id) => id.startsWith("bundled.")) }),
      bundled: { ...bundled, summarize: { ...summarize, enabled: false } },
    },
  };
}
