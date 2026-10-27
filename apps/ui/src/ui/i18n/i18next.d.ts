import 'i18next';

import type boards from './locales/en/boards.json';
import type common from './locales/en/common.json';
import type nav from './locales/en/nav.json';
import type settings from './locales/en/settings.json';

// English catalogs are the source of truth: a key that is not in them is a type error.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: {
      boards: typeof boards;
      common: typeof common;
      nav: typeof nav;
      settings: typeof settings;
    };
  }
}
