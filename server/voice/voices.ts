export type VoiceProfile = {
  key: string;
  displayName: string;
  description: string;
  providerVoiceId: string;
};

const VOICE_PROFILES: VoiceProfile[] = [
  {
    key: "ava-us-1",
    displayName: "Ava",
    description: "Warm & professional",
    providerVoiceId: "Azure.en-US-AvaMultilingualNeural",
  },
  {
    key: "marcus-us-1",
    displayName: "Marcus",
    description: "Calm & confident",
    providerVoiceId: "Azure.en-US-BrianMultilingualNeural",
  },
  {
    key: "sofia-us-1",
    displayName: "Sofia",
    description: "Friendly & upbeat",
    providerVoiceId: "Azure.en-US-EmmaMultilingualNeural",
  },
  {
    key: "james-us-1",
    displayName: "James",
    description: "Clear & direct",
    providerVoiceId: "Azure.en-US-AndrewMultilingualNeural",
  },
];

const byKey = new Map(VOICE_PROFILES.map((profile) => [profile.key, profile]));

export function listVoiceProfiles() {
  return VOICE_PROFILES;
}

export function resolveVoiceProfile(key: string) {
  return byKey.get(key) ?? byKey.get("ava-us-1")!;
}
