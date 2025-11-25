import { useState } from 'react';

const Header = () => {
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
                <img src="/logo.png" alt="Constellation Logo" className="w-8 h-8" />
                <span className="text-xl font-light text-[#5f6368]">Constellation</span>
            </div>

            <nav className="hidden md:flex items-center gap-8">
                {navLinks.map((link) => (
                    <a
                        key={link.name}
                        href={link.href}
                        className="text-[14.5px] text-[#45474d] hover:text-black transition-colors font-sans relative after:absolute after:bottom-0 after:left-0 after:h-[2px] after:w-0 after:bg-black after:transition-all after:duration-300 hover:after:w-full"
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
                        className="text-[14.5px] text-[#45474d] hover:text-black transition-colors font-sans relative after:absolute after:bottom-0 after:left-0 after:h-[2px] after:w-0 after:bg-black after:transition-all after:duration-300 hover:after:w-full"
                    >
                        Use Cases
                    </button>

                    {/* Dropdown Menu */}
                    <div
                        className={`absolute top-full left-1/2 -translate-x-1/2 mt-4 w-80 bg-white rounded-lg shadow-lg border border-gray-100 overflow-hidden transition-all duration-300 ${isUseCasesOpen ? 'opacity-100 visible translate-y-0' : 'opacity-0 invisible -translate-y-2'
                            }`}
                    >
                        <div className="p-2">
                            {useCases.map((useCase) => (
                                <a
                                    key={useCase.name}
                                    href={useCase.href}
                                    className="block px-4 py-3 rounded-md hover:bg-gray-50 transition-colors"
                                >
                                    <div className="font-medium text-[#121317] text-sm">{useCase.name}</div>
                                    <div className="text-xs text-[#5f6368] mt-0.5">{useCase.description}</div>
                                </a>
                            ))}
                        </div>
                    </div>
                </div>
            </nav>

            <div className="flex items-center gap-4">
                {/* Right side actions if any, keeping it simple for now */}
            </div>
        </header>
    );
};

export default Header;
