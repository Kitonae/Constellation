import Header from './components/Header';
import Footer from './components/Footer';
import Hero from './components/Hero';
import ConstellationBackground from './components/ConstellationBackground';

function App() {
  return (
    <div className="min-h-screen bg-white text-[#121317] font-sans flex flex-col relative">
      <ConstellationBackground />
      <Header />
      <main className="flex-grow flex flex-col items-center justify-center w-full relative z-10">
        <Hero />
      </main>
      <Footer />
    </div>
  )
}

export default App
