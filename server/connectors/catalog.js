// Connector catalog. Each entry describes ONE external service: how it
// authenticates, which least-privilege scopes NILCODE requests, which
// capabilities the agent may use, and whether it is actually implemented.
// Adding a connector = adding an entry here + (for OAuth) a provider in
// oauth-providers.js + capability functions in capabilities/<id>.js. Nothing
// else in the app changes.
//
// Honesty rule: `implemented: false` entries show as "Coming soon" in the UI
// and cannot be connected — we never pretend a service works before it does.

export const CATEGORIES = {
  database: 'Database',
  hosting: 'Hosting & Deployment',
  auth: 'Authentication',
  messaging: 'Messaging & Notifications',
  payments: 'Payments',
  api: 'API & Backend',
  vcs: 'Version Control',
  monitoring: 'Monitoring',
  email: 'Email',
  ai: 'AI',
  cms: 'CMS & Content',
  media: 'Media',
  productivity: 'Productivity',
};

const oauth = (config) => ({ type: 'oauth', ...config });
const apiKey = (config) => ({ type: 'api_key', ...config });

export const CATALOG = [
  // ------------------------------------------------------- implemented now --
  {
    id: 'supabase',
    name: 'Supabase',
    category: 'database',
    description: 'Database, authentication and backend services.',
    implemented: true,
    auth: oauth({
      authorizeUrl: 'https://api.supabase.com/v1/oauth/authorize',
      tokenUrl: 'https://api.supabase.com/v1/oauth/token',
      pkce: true,
      // Least privilege by default: the agent can inspect projects and manage
      // them, but cannot read stored secrets until the user grants it.
      scopes: ['projects:read', 'projects:write'],
      scopeDescriptions: {
        'projects:read': 'See your Supabase organizations and projects',
        'projects:write': 'Create and configure Supabase projects',
      },
      scopesExplanation: 'NILCODE can view and manage your Supabase projects. It never asks for your database passwords.',
    }),
    // Capabilities map 1:1 to agent tools (<id>.<capability>).
    capabilities: ['listOrganizations', 'listProjects', 'getProject', 'createProject', 'environmentConfiguration'],
    pricing: 'Free tier available; projects can incur usage charges on your Supabase account.',
    docsUrl: 'https://supabase.com/docs/guides/integrations/oauth-apps',
    envTemplate: (project) => ({
      SUPABASE_URL: project?.apiUrl || '',
      SUPABASE_ANON_KEY: '__SUPABASE_ANON_KEY__',
    }),
  },
  {
    id: 'netlify',
    name: 'Netlify',
    category: 'hosting',
    description: 'Deploy and host web projects with a global CDN.',
    implemented: true,
    auth: oauth({
      authorizeUrl: 'https://app.netlify.com/authorize',
      tokenUrl: 'https://api.netlify.com/oauth/token',
      pkce: false,
      scopes: [],
      scopeDescriptions: {},
      scopesExplanation: 'NILCODE can list your sites, create sites and deploy builds.',
    }),
    capabilities: ['listSites', 'getSite', 'createSite', 'deploy', 'deploymentStatus'],
    pricing: 'Free tier available; large teams/high traffic may incur charges.',
    docsUrl: 'https://docs.netlify.com/api/introduction/',
  },
  {
    id: 'discord',
    name: 'Discord',
    category: 'messaging',
    description: 'Community chat — send notifications and add bots to servers.',
    implemented: true,
    auth: oauth({
      authorizeUrl: 'https://discord.com/oauth2/authorize',
      tokenUrl: 'https://discord.com/api/oauth2/token',
      pkce: false,
      // Explicit bot permissions, NOT administrator. Send Messages (2048) +
      // Create Webhooks (8192) + View channels (1024) = 11264.
      scopes: ['bot', 'webhook.incoming'],
      botPermissions: '11264',
      scopeDescriptions: {
        bot: 'Add a NILCODE bot to servers you choose, with Send Messages + Webhooks only',
        'webhook.incoming': 'Create incoming webhooks so your project can post messages',
      },
      scopesExplanation: 'NILCODE asks for message-sending permissions only — never administrator.',
    }),
    capabilities: ['listGuilds', 'sendMessage', 'createWebhook'],
    pricing: 'Free.',
    docsUrl: 'https://discord.com/developers/docs/topics/oauth2',
  },
  {
    id: 'github',
    name: 'GitHub',
    category: 'vcs',
    description: 'Code hosting, pull requests and publishing.',
    implemented: true,
    // GitHub is already wired through the dedicated token flow in Settings;
    // the connector framework adopts it so the agent sees one uniform view.
    auth: apiKey({
      label: 'Personal access token',
      fields: [
        { name: 'token', label: 'Personal access token (repo scope)', secret: true },
      ],
      testEndpoint: 'https://api.github.com/user',
    }),
    capabilities: ['listRepos'],
    pricing: 'Free for public repositories.',
    docsUrl: 'https://docs.github.com/authentication',
    note: 'Use the existing Settings → GitHub token, or connect it here.',
  },

  // ------------------------------------------------- cataloged, coming soon --
  ...[
    ['vercel', 'Vercel', 'hosting', 'Frontend deployment and edge hosting.'],
    ['gitlab', 'GitLab', 'vcs', 'Code hosting with built-in CI/CD.'],
    ['bitbucket', 'Bitbucket', 'vcs', 'Git hosting for teams.'],
    ['firebase', 'Firebase', 'database', 'Google’s app platform: database, auth, hosting.'],
    ['cloudflare', 'Cloudflare', 'hosting', 'CDN, DNS and edge workers.'],
    ['stripe', 'Stripe', 'payments', 'Payments and billing infrastructure.'],
    ['mongodb-atlas', 'MongoDB Atlas', 'database', 'Managed MongoDB clusters.'],
    ['neon', 'Neon', 'database', 'Serverless Postgres.'],
    ['upstash', 'Upstash', 'database', 'Serverless Redis and queues.'],
    ['sentry', 'Sentry', 'monitoring', 'Error tracking and performance monitoring.'],
    ['resend', 'Resend', 'email', 'Transactional email API.'],
    ['sendgrid', 'SendGrid', 'email', 'Email delivery for applications.'],
    ['twilio', 'Twilio', 'messaging', 'SMS, voice and messaging APIs.'],
    ['slack', 'Slack', 'messaging', 'Team chat — notifications and bots.'],
    ['linear', 'Linear', 'productivity', 'Issue tracking for software teams.'],
    ['notion', 'Notion', 'productivity', 'Docs, wikis and databases.'],
    ['shopify', 'Shopify', 'api', 'Commerce platform for online stores.'],
    ['sanity', 'Sanity', 'cms', 'Structured content backend.'],
    ['cloudinary', 'Cloudinary', 'media', 'Image and video management.'],
    ['clerk', 'Clerk', 'auth', 'Drop-in authentication and user management.'],
    ['auth0', 'Auth0', 'auth', 'Identity platform for applications.'],
    ['openai', 'OpenAI', 'ai', 'GPT models and APIs.'],
    ['anthropic', 'Anthropic', 'ai', 'Claude models and APIs.'],
    ['hugging-face', 'Hugging Face', 'ai', 'Open models and inference.'],
  ].map(([id, name, category, description]) => ({
    id,
    name,
    category,
    description,
    implemented: false,
    capabilities: [],
    pricing: null,
  })),
];

export function getCatalogEntry(id) {
  return CATALOG.find((c) => c.id === id) || null;
}
