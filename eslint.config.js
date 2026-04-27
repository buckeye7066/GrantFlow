import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactRefresh from 'eslint-plugin-react-refresh'
import reactHooks from 'eslint-plugin-react-hooks'

export default [
  {
    ignores: ['dist', 'backend_prev', 'node_modules'],
  },
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: { react, 'react-refresh': reactRefresh, 'react-hooks': reactHooks },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      ...react.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'react/react-in-jsx-scope': 'off',
      'no-unused-vars': 'off',
      'react/prop-types': 'off',
      'react/display-name': 'off',
      'no-prototype-builtins': 'off',
      'react/no-unescaped-entities': 'off',
      'react/no-unknown-property': 'off',
      'react-hooks/rules-of-hooks': 'off',
      'react-hooks/exhaustive-deps': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'no-case-declarations': 'off',
      // Enforce strict equality across the entire repo. Audit flagged
      // `== null` / `!= null` patterns as latent bug surfaces (implicit
      // coercion of user input, DB column values, etc.). Callers that
      // truly mean "null or undefined" must spell it out explicitly.
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // No-console guard: production route/service code must route through
    // backend/utils/logger.js. Test files, scripts, and CLI tooling are
    // still allowed to use console.* directly.
    files: ['backend/routes/**/*.js'],
    rules: {
      // Routes must log through backend/utils/logger.js. console.warn and
      // console.error remain allowed for hard failures during request
      // handling where structured logging is not yet wired.
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['backend/services/**/*.js'],
    rules: {
      // Services are encouraged to log through backend/utils/logger.js;
      // keep this at 'warn' during the ongoing migration so the CI lint
      // step surfaces drift without failing the build on every change.
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['src/**/*.{js,jsx}', 'backend/**/*.js', 'shared/**/*.js'],
    ignores: ['src/utils/fieldDisplay.js'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "FunctionDeclaration[id.name=/^(titleCase|toTitleCase)$/], VariableDeclarator[id.name=/^(titleCase|toTitleCase)$/]",
          message: 'Profile field labels must come from SECTION_METADATA via src/utils/fieldDisplay.js.',
        },
      ],
    },
  },
]
