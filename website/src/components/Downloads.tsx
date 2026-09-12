import { Link } from 'react-router-dom';

interface DownloadsProps {
    isDarkMode: boolean;
}

const Downloads = ({ isDarkMode }: DownloadsProps) => {
    const recentProgress = [
        {
            title: 'Native Direct3D 12 output',
            text: 'Renderer screens open as native Windows processes that draw the show on the GPU, and report their state, frame rate and errors back to the editor.',
        },
        {
            title: 'Hardware video playback',
            text: 'H.264 decodes on the GPU video engine and stays in video memory, with HEVC, VP9 and AV1 on the same path. The HAP family — Hap, Hap Alpha, Hap Q and Hap R — plays and thumbnails natively.',
        },
        {
            title: 'A clock in every output',
            text: 'The shell broadcasts a transport anchor and each output advances its own playhead from it, so a busy editor window does not hold up the picture on stage.',
        },
        {
            title: 'One owner for the document',
            text: 'The desktop shell owns the open show, its unsaved state and the bytes written to disk. Shows are validated and migrated once on load, and unknown data is carried through untouched.',
        },
        {
            title: 'A settled editor shell',
            text: 'Rebuilt on Wails v3, with four selectable themes, design tokens behind every colour and shadow, gesture-level undo, and one shortcut table driving the keys, menus and help.',
        },
    ];

    return (
        <div className="flex flex-col items-center px-4 py-16 max-w-4xl mx-auto w-full">
            <div className="text-center">
                <h1 className={`text-[3rem] leading-[1.1] font-[450] ${isDarkMode ? 'text-white' : 'text-[#121317]'} mb-4`}>
                    Development status
                </h1>
                <p className={`text-xl ${isDarkMode ? 'text-gray-400' : 'text-[#5f6368]'} mb-12 max-w-2xl mx-auto`}>
                    Constellation is in development for show creators.
                </p>
            </div>

            <section className="glass-panel w-full p-8 md:p-12 text-center">
                <h2 className={`text-2xl font-semibold mb-4 ${isDarkMode ? 'text-white' : 'text-[#121317]'}`}>
                    Public downloads are not yet available
                </h2>
                <p className={`text-base leading-relaxed ${isDarkMode ? 'text-gray-300' : 'text-[#45474d]'} mb-6`}>
                    The current work centres on preparing media, editing timelines, composing the stage, and driving native display outputs. These workflows are still evolving.
                </p>
                <p className={`text-base leading-relaxed ${isDarkMode ? 'text-gray-400' : 'text-[#5f6368]'} mb-8`}>
                    Release details and platform availability will be shared here when public downloads are ready.
                </p>
                <div className="flex flex-col sm:flex-row justify-center gap-4">
                    <Link to="/use-cases" className="bg-[#1a73e8] text-white px-6 py-3 rounded-full font-medium hover:bg-[#1557b0] transition-colors">
                        Explore use cases
                    </Link>
                    <Link to="/blog" className={`px-6 py-3 rounded-full font-medium transition-colors border ${isDarkMode ? 'text-white border-gray-600 hover:bg-gray-800' : 'text-[#1a73e8] border-[#dadce0] hover:bg-gray-100'}`}>
                        Read about the editor
                    </Link>
                </div>
            </section>

            <section className="w-full mt-16">
                <h2 className={`text-2xl font-semibold mb-8 text-center ${isDarkMode ? 'text-white' : 'text-[#121317]'}`}>
                    Recent progress
                </h2>
                <ul className="flex flex-col gap-4">
                    {recentProgress.map((item) => (
                        <li key={item.title} className="glass-panel glass-card p-6 text-left">
                            <h3 className={`text-lg font-semibold mb-2 ${isDarkMode ? 'text-white' : 'text-[#121317]'}`}>
                                {item.title}
                            </h3>
                            <p className={`text-base leading-relaxed ${isDarkMode ? 'text-gray-300' : 'text-[#45474d]'}`}>
                                {item.text}
                            </p>
                        </li>
                    ))}
                </ul>
                <p className={`mt-8 text-center text-sm ${isDarkMode ? 'text-gray-400' : 'text-[#5f6368]'}`}>
                    Native output and hardware video playback are Windows features today.
                </p>
            </section>
        </div>
    );
};

export default Downloads;
