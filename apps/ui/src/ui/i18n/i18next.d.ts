import 'i18next';

import type activity from './locales/en/activity.json';
import type analytics from './locales/en/analytics.json';
import type app from './locales/en/app.json';
import type auth from './locales/en/auth.json';
import type board from './locales/en/board.json';
import type boards from './locales/en/boards.json';
import type chat from './locales/en/chat.json';
import type common from './locales/en/common.json';
import type knowledge from './locales/en/knowledge.json';
import type nav from './locales/en/nav.json';
import type onboarding from './locales/en/onboarding.json';
import type search from './locales/en/search.json';
import type settings from './locales/en/settings.json';
import type supervisor from './locales/en/supervisor.json';
import type usage from './locales/en/usage.json';
import type workspaces from './locales/en/workspaces.json';

// English catalogs are the source of truth: a key that is not in them is a type error.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: {
      activity: typeof activity;
      analytics: typeof analytics;
      app: typeof app;
      auth: typeof auth;
      board: typeof board;
      boards: typeof boards;
      chat: typeof chat;
      common: typeof common;
      knowledge: typeof knowledge;
      nav: typeof nav;
      onboarding: typeof onboarding;
      search: typeof search;
      settings: typeof settings;
      supervisor: typeof supervisor;
      usage: typeof usage;
      workspaces: typeof workspaces;
    };
  }
}
