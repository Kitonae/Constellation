import Header from './components/Header';
import Footer from './components/Footer';
import Hero from './components/Hero';

function App() {
  return (
    <div className="min-h-screen bg-white text-[#121317] font-sans flex flex-col">
      <Header />
      <main className="flex-grow flex flex-col items-center justify-center w-full">
        <Hero />
      </main>
      <Footer />
    </div>
  )
}

export default App
