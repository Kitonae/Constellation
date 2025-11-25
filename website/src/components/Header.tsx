import { useState } from 'react';
import logo from '../assets/logo.png';

interface HeaderProps {
    isDarkMode: boolean;
    setIsDarkMode: (value: boolean) => void;
}

const Header = ({ isDarkMode, setIsDarkMode }: HeaderProps) => {
    const [isUseCasesOpen, setIsUseCasesOpen] = useState(false);

    const navLinks = [
        { name: 'Product', href: '#' },
        { name: 'Pricing', href: '#' },
        { name: 'Blog', href: '#' },
        { name: 'Resources', href: '#' },
        { name: 'Download', href: '#' },
    ];

    const useCases = [
        { name: 'Personal Media Library', description: 'Organize your photos and videos', href: '#' },
        { name: 'Team Collaboration', description: 'Share and collaborate with your team', href: '#' },
        { name: 'Content Creation', description: 'Manage your creative projects', href: '#' },
        { name: 'Archive & Backup', description: 'Secure your precious memories', href: '#' },
    ];

    return (
        <header className="flex items-center justify-between px-8 py-6 max-w-7xl mx-auto w-full">
            <div className="flex items-center gap-2">
                <img src={logo} alt="Constellation Logo" className="w-8 h-8" />
                <span className={`text-xl font-light ${isDarkMode ? 'text-gray-300' : 'text-[#5f6368]'}`}>Constellation</span>
            </div>

            <nav className="hidden md:flex items-center gap-8">
                {navLinks.map((link) => (
                    <a
                        key={link.name}
                        href={link.href}
                        className={`text-[14.5px] ${isDarkMode ? 'text-gray-300 hover:text-white' : 'text-[#45474d] hover:text-black'} transition-colors font-sans relative after:absolute after:bottom-0 after:left-0 after:h-[2px] after:w-0 ${isDarkMode ? 'after:bg-white' : 'after:bg-black'} after:transition-all after:duration-300 hover:after:w-full`}
                    >
                        {link.name}
                    </a>
                ))}

                {/* Use Cases with Dropdown */}
                <div
                    className="relative"
                    onMouseEnter={() => setIsUseCasesOpen(true)}
                    onMouseLeave={() => setIsUseCasesOpen(false)}
                >
                    <button
                        className={`text-[14.5px] ${isDarkMode ? 'text-gray-300 hover:text-white' : 'text-[#45474d] hover:text-black'} transition-colors font-sans relative after:absolute after:bottom-0 after:left-0 after:h-[2px] after:w-0 ${isDarkMode ? 'after:bg-white' : 'after:bg-black'} after:transition-all after:duration-300 hover:after:w-full`}
                    >
                        Use Cases
                    </button>

                    {/* Dropdown Menu */}
                    <div
                        className={`absolute top-full left-1/2 -translate-x-1/2 mt-4 w-80 ${isDarkMode ? 'bg-[#1a1a1a]' : 'bg-white'} rounded-lg shadow-lg border ${isDarkMode ? 'border-gray-700' : 'border-gray-100'} overflow-hidden transition-all duration-300 ${isUseCasesOpen ? 'opacity-100 visible translate-y-0' : 'opacity-0 invisible -translate-y-2'
                            }`}
                    >
                        <div className="p-2">
                            {useCases.map((useCase) => (
                                <a
                                    key={useCase.name}
                                    href={useCase.href}
                                    className={`block px-4 py-3 rounded-md ${isDarkMode ? 'hover:bg-gray-800' : 'hover:bg-gray-50'} transition-colors`}
                                >
                                    <div className={`font-medium text-sm ${isDarkMode ? 'text-white' : 'text-[#121317]'}`}>{useCase.name}</div>
                                    <div className={`text-xs mt-0.5 ${isDarkMode ? 'text-gray-400' : 'text-[#5f6368]'}`}>{useCase.description}</div>
                                </a>
                            ))}
                        </div>
                    </div>
                </div>
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
