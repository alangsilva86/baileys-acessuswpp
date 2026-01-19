module.exports = {
  content: ['./public/**/*.{html,js}'],
  theme: {
    extend: {
      colors: {
        ink: '#0f172a',
        muted: '#64748b',
        surface: '#ffffff',
        'surface-2': '#f8fafc',
        'surface-3': '#f1f5f9',
        border: '#e2e8f0',
        primary: {
          DEFAULT: '#059669',
          dark: '#047857',
          soft: '#ecfdf5',
        },
        success: {
          DEFAULT: '#16a34a',
          soft: '#dcfce7',
        },
        warning: {
          DEFAULT: '#d97706',
          soft: '#fef3c7',
        },
        danger: {
          DEFAULT: '#e11d48',
          soft: '#ffe4e6',
        },
        info: {
          DEFAULT: '#0284c7',
          soft: '#e0f2fe',
        },
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '0.95rem' }],
      },
      spacing: {
        18: '4.5rem',
        22: '5.5rem',
      },
      boxShadow: {
        soft: '0 10px 30px -20px rgba(15, 23, 42, 0.35)',
      },
    },
  },
  plugins: [],
};
