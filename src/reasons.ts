export const PRESET_NAMES = ['network', 'away', 'end-of-day', 'limit'] as const;
export type Preset = (typeof PRESET_NAMES)[number];

interface Sentences {
  pause: string;
  continue: string;
}

const NEUTRAL: Sentences = { pause: 'The user asked all agents to pause.', continue: 'The user asked you to continue.' };

const PRESETS: Record<Preset, Sentences> = {
  network: { pause: 'The user is leaving and the network will drop.', continue: 'The network is back.' },
  away: { pause: 'The user is stepping away for a while.', continue: 'The user is back.' },
  'end-of-day': { pause: 'The user is stopping work for the day.', continue: 'The user is back for a new session.' },
  limit: { pause: 'The user is close to a usage or rate limit.', continue: 'The limit has reset.' },
};

export function isPreset(value: unknown): value is Preset {
  return PRESET_NAMES.some((name) => name === value);
}

// Records are not validated on load: a value that is not a preset counts as absent.
const sentences = (preset?: string): Sentences => (isPreset(preset) ? PRESETS[preset] : NEUTRAL);

export const pauseSentence = (preset?: string): string => sentences(preset).pause;

export const continueSentence = (preset?: string): string => sentences(preset).continue;

export const mismatchMessage = (preset?: string): string =>
  isPreset(preset)
    ? `This run was paused with --reason ${preset}; use --reason ${preset}, or close it first.`
    : 'This run was paused without --reason; run pause without --reason, or close it first.';
