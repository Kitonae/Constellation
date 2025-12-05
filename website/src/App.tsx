import { useState } from 'react';
import { Routes, Route } from 'react-router-dom';
import Header from './components/Header';
import Footer from './components/Footer';
import Hero from './components/Hero';
import Downloads from './components/Downloads';
import UseCases from './components/UseCases';
import Blog from './components/Blog';
import ConstellationBackground from './components/ConstellationBackground';

function App() {
  const [isDarkMode, setIsDarkMode] = useState(false);

  return (
    <div className={`min-h-screen ${isDarkMode ? 'bg-[#0a0a0a] text-white' : 'bg-white text-[#121317]'} font-sans flex flex-col relative transition-colors duration-300`}>
      <ConstellationBackground isDarkMode={isDarkMode} />
      <Header isDarkMode={isDarkMode} setIsDarkMode={setIsDarkMode} />
      <main className="flex-grow flex flex-col items-center justify-center w-full relative z-10">
        <Routes>
          <Route path="/" element={<Hero isDarkMode={isDarkMode} />} />
          <Route path="/downloads" element={<Downloads isDarkMode={isDarkMode} />} />
          <Route path="/use-cases" element={<UseCases isDarkMode={isDarkMode} />} />
          <Route path="/blog" element={<Blog isDarkMode={isDarkMode} />} />
        </Routes>
      </main>
      <Footer isDarkMode={isDarkMode} />
    </div>
  )
}

export default App
