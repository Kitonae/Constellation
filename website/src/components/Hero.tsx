import { Link } from 'react-router-dom';
import logo from '../assets/logo.png';

interface HeroProps {
    isDarkMode: boolean;
}

const Hero = ({ isDarkMode }: HeroProps) => {
    return (
        <div className="flex flex-col items-center justify-center text-center px-4">
            <div className="flex items-center gap-2 mb-8">
                <img src={logo} alt="Constellation Logo" className="w-8 h-8" />
                <span className={`text-xl font-light ${isDarkMode ? 'text-gray-300' : 'text-[#5f6368]'}`}>Constellation</span>
            </div>
            <h1 className={`text-[3rem] leading-[1.1] font-sans ${isDarkMode ? 'text-white' : 'text-[#121317]'} max-w-4xl mb-12`}>
                <span className="font-[450]">Your media universe</span>
                <br />
                <span className={`text-[2rem] ${isDarkMode ? 'text-gray-400' : 'text-[#5f6368]'} font-normal`}>Beautifully organised and presented</span>
            </h1>
            <div className="flex gap-4">
                <Link to="/downloads" className="bg-[#1a73e8] text-white px-6 py-3 rounded-full font-medium hover:bg-[#1557b0] transition-colors">
                    Download for MacOS
                </Link>
                <Link to="/use-cases" className={`${isDarkMode ? 'text-white border-gray-600 hover:bg-gray-800' : 'text-[#1a73e8] border-[#dadce0] hover:bg-gray-100'} px-6 py-3 rounded-full font-medium transition-colors border`}>
                    Explore use cases
                </Link>
            </div>
        </div>
    );
};

export default Hero;
