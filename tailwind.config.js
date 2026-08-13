/** @type {import('tailwindcss').Config} */

// Design tokens ported verbatim from .superdesign/design-system.md.
// The mockups in .superdesign/export/ were generated against the Tailwind v3
// CDN, so this project pins v3 to keep class names identical to the mockups.
//
// IMPORTANT — role colors:
// The `role.*` palette below is the SEED/default set only. Spec §6 makes role
// colors admin-editable (shiftRoles/{roleId}.color), so anything rendering a
// live role must read that color from Firestore and apply it as an inline
// style. Tailwind cannot express runtime-dynamic colors. Use `role.*` for
// static surfaces (the design-system gallery, legends, seed data) only.

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Surfaces
        page: '#FFFFFF',
        app: '#F8F8F7',
        rail: '#F5F4F2',
        hover: '#FAFAFA',

        // Structure — borders do the work, not shadows
        line: '#E5E7EB',

        // Text
        ink: {
          DEFAULT: '#1F2937', // primary
          muted: '#6B7280', // secondary
        },

        // Actions & semantics
        primary: {
          DEFAULT: '#2563EB',
          tint: '#EFF6FF',
        },
        success: {
          DEFAULT: '#14B8A6',
          tint: '#E6F7F5',
        },
        danger: {
          DEFAULT: '#EF4444',
          tint: '#FDE8E8',
        },
        warning: {
          DEFAULT: '#F59E0B',
          tint: '#FEF3D9',
        },

        // Brand — logo and small accents ONLY. Never a button color.
        brand: '#B4232A',

        // Shift-role band colors (seed defaults — see note above)
        role: {
          server: '#F5A623',
          onCallServer: '#64748B',
          bartender: '#8B5CF6',
          host: '#F97316',
          runner: '#06B6D4',
          shiftSupervisor: '#22C55E',
          manager: '#EC4899',
          expo: '#14B8A6',
          barista: '#A16207',
          // Kitchen Lead is absent from design-system.md §2 (it appears only in
          // mockup 32's role table). Rafa ruled it a distinct deep bronze on
          // Aug 13 2026 so it cannot be confused with Hot Line Cook's oranger
          // #B45309 or Cold Line Cook's redder #92400E at chip size.
          kitchenLead: '#7B4B2A',
          hotLine: '#B45309',
          coldLine: '#92400E',
          prep: '#78716C',
          dish: '#57534E',
        },
      },

      fontFamily: {
        sans: [
          'Inter',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
      },

      fontSize: {
        // name: [size, { lineHeight, letterSpacing, fontWeight }]
        micro: ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.04em' }], // 11px chips/bands
        chip: ['0.75rem', { lineHeight: '1rem' }], // 12px
        meta: ['0.8125rem', { lineHeight: '1.25rem' }], // 13px
        body: ['1rem', { lineHeight: '1.5rem' }], // 16px
        section: ['1.125rem', { lineHeight: '1.75rem' }], // 18px
        title: ['1.5rem', { lineHeight: '2rem' }], // 24px
        'title-lg': ['1.75rem', { lineHeight: '2.25rem' }], // 28px
      },

      borderRadius: {
        control: '0.5rem', // 8px — buttons, inputs
        card: '0.75rem', // 12px
        'card-lg': '1rem', // 16px
        sheet: '1.5rem', // 24px — mobile bottom sheets
      },

      boxShadow: {
        // Cards are flat with a border. Only modals/dropdowns/toasts elevate.
        elevated: '0 4px 16px rgba(0, 0, 0, 0.08)',
        drawer: '-4px 0 16px rgba(0, 0, 0, 0.06)',
        sheet: '0 -4px 16px rgba(0, 0, 0, 0.08)',
      },

      spacing: {
        // Named shell dimensions so the two shells stay consistent.
        rail: '3.75rem', // 60px desktop icon rail
        topbar: '3.75rem', // 60px desktop top bar
        tabbar: '3.5rem', // 56px mobile bottom tab bar
        'safe-top': 'env(safe-area-inset-top, 0px)',
        'safe-bottom': 'env(safe-area-inset-bottom, 0px)',
      },

      transitionDuration: {
        // Restrained and fast. No bounce, no parallax.
        hover: '150ms',
        surface: '200ms',
      },

      keyframes: {
        skeleton: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.55' },
        },
      },
      animation: {
        skeleton: 'skeleton 1.5s ease-in-out infinite',
      },
    },
  },
  plugins: [
    // Utilities the design system requires but Tailwind v3 lacks out of the box.
    function ({ addUtilities }) {
      addUtilities({
        // All numbers — hours, $, % — must align on the decimal. design-system.md §3
        '.tabular': { fontVariantNumeric: 'tabular-nums' },
        // Safe-area padding helpers. Spec §15.
        '.pt-safe': { paddingTop: 'env(safe-area-inset-top, 0px)' },
        '.pb-safe': { paddingBottom: 'env(safe-area-inset-bottom, 0px)' },
        '.pl-safe': { paddingLeft: 'env(safe-area-inset-left, 0px)' },
        '.pr-safe': { paddingRight: 'env(safe-area-inset-right, 0px)' },
        '.mt-safe': { marginTop: 'env(safe-area-inset-top, 0px)' },
        '.mb-safe': { marginBottom: 'env(safe-area-inset-bottom, 0px)' },
        '.h-safe-top': { height: 'env(safe-area-inset-top, 0px)' },
        '.h-safe-bottom': { height: 'env(safe-area-inset-bottom, 0px)' },
      })
    },
  ],
}
