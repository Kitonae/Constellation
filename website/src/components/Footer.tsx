interface FooterProps {
    isDarkMode: boolean;
}

const Footer = ({ isDarkMode }: FooterProps) => {
    return (
        <footer className={`w-full py-8 flex justify-center gap-8 text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
            <a href="#" className={`${isDarkMode ? 'hover:text-white' : 'hover:text-black'} transition-colors`}>Docs</a>
            <a href="#" className={`${isDarkMode ? 'hover:text-white' : 'hover:text-black'} transition-colors`}>Twitter</a>
        </footer>
    );
};

export default Footer;
