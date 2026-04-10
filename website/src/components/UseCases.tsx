import { Link } from 'react-router-dom';

interface UseCasesProps {
    isDarkMode: boolean;
}

const UseCases = ({ isDarkMode }: UseCasesProps) => {
    const useCases = [
        {
            title: 'Personal Media Library',
            description: 'Organize your photos and videos',
            icon: (
                <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
            ),
            features: [
                'Smart organization with automatic tagging',
                'Advanced search and filtering capabilities',
                'Timeline view of your memories',
                'Duplicate detection and management',
            ],
        },
        {
            title: 'Team Collaboration',
            description: 'Share and collaborate with your team',
            icon: (
                <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                </svg>
            ),
            features: [
                'Real-time collaboration on media projects',
                'Shared collections and albums',
                'Permission-based access control',
                'Activity tracking and notifications',
            ],
        },
        {
            title: 'Content Creation',
            description: 'Manage your creative projects',
            icon: (
                <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                </svg>
            ),
            features: [
                'Project-based organization',
                'Version control for media files',
                'Integration with creative tools',
                'Export and publishing workflows',
            ],
        },
        {
            title: 'Archive & Backup',
            description: 'Secure your precious memories',
            icon: (
                <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
                </svg>
            ),
            features: [
                'Automated backup scheduling',
                'Multiple storage location support',
                'Data integrity verification',
                'Long-term archival solutions',
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
                    Discover how Constellation can transform your media management workflow
                </p>
            </div>

            <div className="grid md:grid-cols-2 gap-8 w-full">
                {useCases.map((useCase, index) => (
                    <div
                        key={index}
                        className={`${isDarkMode ? 'bg-[#1a1a1a] border-gray-700' : 'bg-white border-gray-200'
                            } border rounded-2xl p-8 transition-all duration-300 hover:shadow-2xl ${isDarkMode ? 'hover:border-gray-500' : 'hover:border-gray-300'
                            }`}
                    >
                        <div className={`${isDarkMode ? 'text-blue-400' : 'text-[#1a73e8]'} mb-4`}>
                            {useCase.icon}
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

            <div className={`mt-16 text-center p-8 rounded-2xl ${isDarkMode ? 'bg-[#1a1a1a]' : 'bg-gray-50'} max-w-3xl`}>
                <h3 className={`text-2xl font-semibold mb-4 ${isDarkMode ? 'text-white' : 'text-[#121317]'}`}>
                    Ready to get started?
                </h3>
                <p className={`text-base ${isDarkMode ? 'text-gray-400' : 'text-[#5f6368]'} mb-6`}>
                    Download Constellation today and experience the future of media management
                </p>
                <Link
                    to="/downloads"
                    className="inline-block bg-[#1a73e8] text-white px-8 py-3 rounded-full font-medium hover:bg-[#1557b0] transition-colors"
                >
                    Download Now
                </Link>
            </div>
        </div>
    );
};

export default UseCases;
