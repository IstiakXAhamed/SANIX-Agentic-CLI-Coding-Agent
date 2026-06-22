// ESLint 9 flat config — uses eslint-config-next 16 (already an array).
import next from 'eslint-config-next';

/** @type {import('eslint').Linter.Config[]} */
const config = [
  {
    ignores: ['node_modules/**', '.next/**', 'dist/**', 'out/**'],
  },
  ...next,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-unused-expressions': 'off',
      'react-hooks/exhaustive-deps': 'warn',
      // React 18 doesn't have the purity / set-state-in-effect rules;
      // eslint-plugin-react-hooks v7 enforces them but they're only
      // relevant for React 19's compiler-aware runtime. We're on React 18.
      'react-hooks/purity': 'off',
      'react-hooks/set-state-in-effect': 'off',
      '@next/next/no-html-link-for-pages': 'off',
    },
  },
];

export default config;

