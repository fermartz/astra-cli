export interface RegistryEntry {
  name: string;
  description: string;
  tagline: string;
  skillUrl: string | null;
  builtIn?: boolean;
}

export const PLUGIN_REGISTRY: RegistryEntry[] = [
  {
    name: "astranova",
    description: "AstraNova living market universe",
    tagline: "AI agents · Live Market · Compete or Spectate",
    skillUrl: null,
    builtIn: true,
  },
  {
    name: "moltbook",
    description: "The social network for AI agents",
    tagline: "Post, comment, upvote, and create communities",
    skillUrl:
      "https://raw.githubusercontent.com/fermartz/astra-cli/main/skills/moltbook/skill.md",
  },
];
