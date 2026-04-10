import { Link } from 'react-router-dom';
import logo from '../assets/logo.png';

interface HeaderProps {
    isDarkMode: boolean;
    setIsDarkMode: (value: boolean) => void;
}

const Header = ({ isDarkMode, setIsDarkMode }: HeaderProps) => {
    const navLinks = [
        { name: 'Product', href: '/' },
        { name: 'Blog', href: '/blog' },
        { name: 'Resources', href: '#' },
        { name: 'Download', href: '/downloads' },
    ];

    return (
        <header className="flex items-center justify-between px-8 py-6 max-w-7xl mx-auto w-full">
            <div className="flex items-center gap-2">
                <img src={logo} alt="Constellation Logo" className="w-8 h-8" />
                <span className={`text-xl font-light ${isDarkMode ? 'text-gray-300' : 'text-[#5f6368]'}`}>Constellation</span>
            </div>

            <nav className="hidden md:flex items-center gap-8">
                {navLinks.map((link) => (
                    link.name === 'Download' || link.name === 'Product' || link.name === 'Blog' ? (
                        <Link
                            key={link.name}
                            to={link.href}
                            className={`text-[14.5px] ${isDarkMode ? 'text-gray-300 hover:text-white' : 'text-[#45474d] hover:text-black'} transition-colors font-sans relative after:absolute after:bottom-0 after:left-0 after:h-[2px] after:w-0 ${isDarkMode ? 'after:bg-white' : 'after:bg-black'} after:transition-all after:duration-300 hover:after:w-full`}
                        >
                            {link.name}
                        </Link>
                    ) : (
                        <a
                            key={link.name}
                            href={link.href}
                            className={`text-[14.5px] ${isDarkMode ? 'text-gray-300 hover:text-white' : 'text-[#45474d] hover:text-black'} transition-colors font-sans relative after:absolute after:bottom-0 after:left-0 after:h-[2px] after:w-0 ${isDarkMode ? 'after:bg-white' : 'after:bg-black'} after:transition-all after:duration-300 hover:after:w-full`}
                        >
                            {link.name}
                        </a>
                    )
                ))}

                {/* Use Cases Link */}
                <Link
                    to="/use-cases"
                    className={`text-[14.5px] ${isDarkMode ? 'text-gray-300 hover:text-white' : 'text-[#45474d] hover:text-black'} transition-colors font-sans relative after:absolute after:bottom-0 after:left-0 after:h-[2px] after:w-0 ${isDarkMode ? 'after:bg-white' : 'after:bg-black'} after:transition-all after:duration-300 hover:after:w-full`}
                >
                    Use Cases
                </Link>
            </nav>

            <div className="flex items-center gap-4">
                {/* Dark Mode Toggle */}
                <button
                    onClick={() => setIsDarkMode(!isDarkMode)}
                    className={`p-2 rounded-full ${isDarkMode ? 'bg-gray-800 hover:bg-gray-700' : 'bg-gray-100 hover:bg-gray-200'} transition-colors`}
                    aria-label="Toggle dark mode"
                >
                    {isDarkMode ? (
                        <svg className="w-5 h-5 text-yellow-400" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clipRule="evenodd" />
                        </svg>
                    ) : (
                        <svg className="w-5 h-5 text-gray-700" fill="currentColor" viewBox="0 0 20 20">
                            <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
                        </svg>
                    )}
                </button>
            </div>
        </header>
    );
};

export default Header;
