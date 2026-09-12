import { Link } from 'react-router-dom';

interface FooterProps {
    isDarkMode: boolean;
}

const Footer = ({ isDarkMode }: FooterProps) => {
    return (
        <footer className={`relative z-10 w-full px-4 py-8 flex flex-wrap justify-center gap-x-8 gap-y-4 text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
            <Link to="/use-cases" className={`${isDarkMode ? 'hover:text-white' : 'hover:text-black'} transition-colors`}>Use Cases</Link>
            <Link to="/blog" className={`${isDarkMode ? 'hover:text-white' : 'hover:text-black'} transition-colors`}>Blog</Link>
            <Link to="/downloads" className={`${isDarkMode ? 'hover:text-white' : 'hover:text-black'} transition-colors`}>Development status</Link>
        </footer>
    );
};

export default Footer;
