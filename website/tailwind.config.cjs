/** @type {import('tailwindcss').Config} */
module.exports = {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            colors: {
                'ag-black': '#121317',
                'ag-gray': '#45474d',
                'ag-text': '#e0e0e0',
                'ag-text-muted': '#a0a0a0',
            },
            fontFamily: {
                sans: ['Inter', 'Roboto', 'sans-serif'],
            },
        },
    },
    plugins: [],
}
