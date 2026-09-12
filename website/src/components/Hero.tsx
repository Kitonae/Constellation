import { Link } from 'react-router-dom';
import logo from '../assets/logo.png';

interface HeroProps {
    isDarkMode: boolean;
}

const Hero = ({ isDarkMode }: HeroProps) => {
    return (
        <div className="glass-panel glass-hero flex flex-col items-center justify-center text-center">
            <div className="flex items-center gap-2 mb-8">
                <img src={logo} alt="Constellation Logo" className="w-8 h-8" />
                <span className={`text-xl font-light ${isDarkMode ? 'text-gray-300' : 'text-[#5f6368]'}`}>Constellation</span>
            </div>
            <p className={`text-sm font-medium ${isDarkMode ? 'text-blue-400' : 'text-[#1a73e8]'} mb-4`}>Desktop show editor · In development</p>
            <h1 className={`text-[2.5rem] sm:text-[3rem] leading-[1.1] font-sans ${isDarkMode ? 'text-white' : 'text-[#121317]'} max-w-4xl mb-6`}>
                <span className="font-[450]">Build your show.</span>
                <br />
                <span className={`text-[2rem] ${isDarkMode ? 'text-gray-400' : 'text-[#5f6368]'} font-normal`}>Shape every screen.</span>
            </h1>
            <p className={`text-lg leading-relaxed ${isDarkMode ? 'text-gray-400' : 'text-[#5f6368]'} max-w-2xl mb-10`}>
                Arrange your media, edit sequences on a timeline, and compose your display outputs on a 2D stage. Every output is drawn by a native Direct3D 12 renderer, so the picture on stage keeps its own clock.
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
                <Link to="/downloads" className="bg-[#1a73e8] text-white px-6 py-3 rounded-full font-medium hover:bg-[#1557b0] transition-colors">
                    Development status
                </Link>
                <Link to="/use-cases" className={`${isDarkMode ? 'text-white border-gray-600 hover:bg-gray-800' : 'text-[#1a73e8] border-[#dadce0] hover:bg-gray-100'} px-6 py-3 rounded-full font-medium transition-colors border`}>
                    Explore use cases
                </Link>
            </div>
        </div>
    );
};

export default Hero;
