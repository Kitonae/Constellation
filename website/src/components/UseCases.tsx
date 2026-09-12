import { Link } from 'react-router-dom';

interface UseCasesProps {
    isDarkMode: boolean;
}

const UseCases = ({ isDarkMode }: UseCasesProps) => {
    const useCases = [
        {
            title: 'Prepare your media',
            description: 'Bring the assets for your show into one media bin.',
            features: [
                'Import files by dropping them into the editor',
                'Search, sort, and filter assets by media kind',
                'Rename assets to make them easier to find',
                'Relink moved files across every clip that uses them',
            ],
        },
        {
            title: 'Sequence your show',
            description: 'Set the timing and order of your media on the timeline.',
            features: [
                'Arrange clips across tracks and move selections together',
                'Trim clip edges, duplicate clips, and split at the playhead',
                'Snap edits to the playhead and other clip edges',
                'Scrub, play, and pause to review your sequence',
            ],
        },
        {
            title: 'Compose your stage',
            description: 'Shape how your media sits across screens in a 2D workspace.',
            features: [
                'Drag screens and clips directly on the stage',
                'Resize selected clips with on-stage handles',
                'Pan, zoom, and frame your selection',
                'Save your show and return to it for further editing',
            ],
        },
        {
            title: 'Manage your display outputs',
            description: 'Connect the screens in your show to output windows.',
            features: [
                'Add web or native renderer screens to your stage',
                'Open, close, and reopen display outputs from the editor',
                'Inspect renderer status, frame rate, and errors',
                'Relaunch a native renderer from its screen inspector',
            ],
        },
        {
            title: 'Play back on the GPU',
            description: 'A native Windows renderer draws each output with Direct3D 12.',
            features: [
                'Play the HAP family: Hap, Hap Alpha, Hap Q and Hap R',
                'Decode H.264 on the GPU video engine, with HEVC, VP9 and AV1 alongside it',
                'Keep decoded frames on the GPU instead of copying them back',
                'Give one output the soundtrack, handed on if that output closes',
            ],
        },
        {
            title: 'Work the way you like',
            description: 'The editor shell adapts to the show in front of you.',
            features: [
                'Drag any divider, or collapse a panel to a rail it remembers',
                'Choose between four themes in settings',
                'Undo and redo by the gesture, not the internal step',
                'Read every shortcut from one table that also drives the menus',
            ],
        },
    ];

    return (
        <div className="flex flex-col items-center px-4 py-16 max-w-7xl mx-auto w-full">
            <div className="text-center mb-16">
                <h1 className={`text-[3rem] leading-[1.1] font-[450] ${isDarkMode ? 'text-white' : 'text-[#121317]'} mb-4`}>
                    Use Cases
                </h1>
                <p className={`text-xl ${isDarkMode ? 'text-gray-400' : 'text-[#5f6368]'} max-w-2xl mx-auto`}>
                    From the first asset to your display outputs, explore the workflow taking shape in Constellation.
                </p>
            </div>

            <div className="grid md:grid-cols-2 gap-8 w-full">
                {useCases.map((useCase, index) => (
                    <div
                        key={index}
                        className="glass-panel glass-card p-8"
                    >
                        <div aria-hidden="true" className={`${isDarkMode ? 'text-blue-400' : 'text-[#1a73e8]'} text-3xl font-medium mb-4`}>
                            {String(index + 1).padStart(2, '0')}
                        </div>

                        <h2 className={`text-2xl font-semibold mb-2 ${isDarkMode ? 'text-white' : 'text-[#121317]'}`}>
                            {useCase.title}
                        </h2>

                        <p className={`text-base ${isDarkMode ? 'text-gray-400' : 'text-[#5f6368]'} mb-6`}>
                            {useCase.description}
                        </p>

                        <ul className={`space-y-3 ${isDarkMode ? 'text-gray-300' : 'text-[#45474d]'}`}>
                            {useCase.features.map((feature, featureIndex) => (
                                <li key={featureIndex} className="flex items-start">
                                    <svg className={`w-5 h-5 mr-3 mt-0.5 flex-shrink-0 ${isDarkMode ? 'text-blue-400' : 'text-[#1a73e8]'}`} fill="currentColor" viewBox="0 0 20 20">
                                        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                                    </svg>
                                    <span className="text-sm">{feature}</span>
                                </li>
                            ))}
                        </ul>
                    </div>
                ))}
            </div>

            <div className="glass-panel mt-16 text-center p-8 max-w-3xl">
                <h3 className={`text-2xl font-semibold mb-4 ${isDarkMode ? 'text-white' : 'text-[#121317]'}`}>
                    Follow the editor’s development
                </h3>
                <p className={`text-base ${isDarkMode ? 'text-gray-400' : 'text-[#5f6368]'} mb-6`}>
                    Constellation is in development. Public downloads are not yet available.
                </p>
                <Link
                    to="/downloads"
                    className="inline-block bg-[#1a73e8] text-white px-8 py-3 rounded-full font-medium hover:bg-[#1557b0] transition-colors"
                >
                    Development status
                </Link>
            </div>
        </div>
    );
};

export default UseCases;
