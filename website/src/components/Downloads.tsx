interface DownloadsProps {
    isDarkMode: boolean;
}

const Downloads = ({ isDarkMode }: DownloadsProps) => {
    const downloadOptions = [
        {
            platform: 'Windows',
            icon: (
                <svg className="w-16 h-16" viewBox="0 0 88 88" fill="currentColor">
                    <path d="M0 12.402l35.687-4.86.016 34.423-35.67.203zm35.67 33.529l.028 34.453L.028 75.48.026 45.7zm4.326-39.025L87.314 0v41.527l-47.318.376zm47.329 39.349l-.011 41.34-47.318-6.678-.066-34.739z" />
                </svg>
            ),
            version: '1.0.0',
            size: '85 MB',
            requirements: 'Windows 10 or later',
            downloadUrl: '#',
        },
        {
            platform: 'macOS',
            icon: (
                <svg className="w-16 h-16" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
                </svg>
            ),
            version: '1.0.0',
            size: '120 MB',
            requirements: 'macOS 11.0 or later',
            downloadUrl: '#',
        },
    ];

    return (
        <div className="flex flex-col items-center justify-center text-center px-4 py-16 max-w-6xl mx-auto">
            <h1 className={`text-[3rem] leading-[1.1] font-[450] ${isDarkMode ? 'text-white' : 'text-[#121317]'} mb-4`}>
                Download Constellation
            </h1>
            <p className={`text-xl ${isDarkMode ? 'text-gray-400' : 'text-[#5f6368]'} mb-16 max-w-2xl`}>
                Choose your platform and start organizing your media universe today
            </p>

            <div className="grid md:grid-cols-2 gap-8 w-full">
                {downloadOptions.map((option) => (
                    <div
                        key={option.platform}
                        className={`${isDarkMode ? 'bg-[#1a1a1a] border-gray-700' : 'bg-white border-gray-200'
                            } border rounded-2xl p-8 transition-all duration-300 hover:shadow-2xl ${isDarkMode ? 'hover:border-gray-500' : 'hover:border-gray-300'
                            }`}
                    >
                        <div className={`${isDarkMode ? 'text-blue-400' : 'text-[#1a73e8]'} mb-6 flex justify-center`}>
                            {option.icon}
                        </div>

                        <h2 className={`text-2xl font-semibold mb-2 ${isDarkMode ? 'text-white' : 'text-[#121317]'}`}>
                            {option.platform}
                        </h2>

                        <div className={`text-sm ${isDarkMode ? 'text-gray-400' : 'text-[#5f6368]'} mb-6 space-y-1`}>
                            <p>Version {option.version}</p>
                            <p>{option.size}</p>
                            <p>{option.requirements}</p>
                        </div>

                        <a
                            href={option.downloadUrl}
                            className="inline-block w-full bg-[#1a73e8] text-white px-6 py-3 rounded-full font-medium hover:bg-[#1557b0] transition-colors"
                        >
                            Download for {option.platform}
                        </a>
                    </div>
                ))}
            </div>

            <div className={`mt-16 p-6 rounded-lg ${isDarkMode ? 'bg-[#1a1a1a]' : 'bg-gray-50'} max-w-3xl`}>
                <h3 className={`text-lg font-semibold mb-3 ${isDarkMode ? 'text-white' : 'text-[#121317]'}`}>
                    Installation Notes
                </h3>
                <ul className={`text-sm ${isDarkMode ? 'text-gray-400' : 'text-[#5f6368]'} space-y-2 text-left`}>
                    <li>• After downloading, open the installer and follow the on-screen instructions</li>
                    <li>• You may need to allow installation from unidentified developers in your system settings</li>
                    <li>• For updates and release notes, visit our documentation</li>
                </ul>
            </div>
        </div>
    );
};

export default Downloads;
