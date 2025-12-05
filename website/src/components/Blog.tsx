import { Link } from 'react-router-dom';

interface BlogProps {
    isDarkMode: boolean;
}

const Blog = ({ isDarkMode }: BlogProps) => {
    const blogPost = {
        title: 'Introducing Constellation: The Future of Media Management',
        date: 'December 2, 2024',
        author: 'Constellation Team',
        readTime: '5 min read',
        excerpt: 'We\'re excited to announce Constellation, a revolutionary media management platform designed to transform how you organize, discover, and enjoy your digital content.',
        content: [
            {
                type: 'paragraph',
                text: 'In today\'s digital age, we\'re creating and consuming more media than ever before. Photos, videos, music, documents - our digital libraries are growing exponentially. Yet, managing this content remains surprisingly difficult. Files get scattered across devices, duplicates accumulate, and finding that one special photo from years ago becomes a frustrating treasure hunt.',
            },
            {
                type: 'heading',
                text: 'A New Approach to Media Management',
            },
            {
                type: 'paragraph',
                text: 'Constellation was born from a simple question: What if managing your media library could be as beautiful and intuitive as browsing your favorite streaming service? We set out to create a platform that doesn\'t just store your files, but helps you rediscover and enjoy them.',
            },
            {
                type: 'heading',
                text: 'Key Features',
            },
            {
                type: 'list',
                items: [
                    'Smart Organization: Automatic tagging and categorization powered by AI',
                    'Universal Search: Find anything instantly with natural language queries',
                    'Beautiful Presentation: Your media deserves to be displayed beautifully',
                    'Cross-Platform Sync: Access your library from anywhere, on any device',
                    'Privacy First: Your data stays yours, with end-to-end encryption',
                ],
            },
            {
                type: 'heading',
                text: 'Built for Everyone',
            },
            {
                type: 'paragraph',
                text: 'Whether you\'re a photographer managing thousands of RAW files, a content creator organizing project assets, or simply someone who wants to preserve family memories, Constellation adapts to your needs. Our flexible architecture supports personal libraries, team collaboration, and everything in between.',
            },
            {
                type: 'heading',
                text: 'What\'s Next',
            },
            {
                type: 'paragraph',
                text: 'This is just the beginning. We\'re actively developing new features including advanced sharing capabilities, AI-powered content discovery, and integrations with your favorite creative tools. We\'re building Constellation in the open, and we\'d love to hear your feedback.',
            },
            {
                type: 'paragraph',
                text: 'Ready to transform your media management experience? Download Constellation today and join us in reimagining how we interact with our digital content.',
            },
        ],
    };

    return (
        <div className="flex flex-col items-center px-4 py-16 max-w-4xl mx-auto w-full">
            {/* Blog Header */}
            <div className="text-center mb-12">
                <h1 className={`text-[3rem] leading-[1.1] font-[450] ${isDarkMode ? 'text-white' : 'text-[#121317]'} mb-4`}>
                    Blog
                </h1>
                <p className={`text-xl ${isDarkMode ? 'text-gray-400' : 'text-[#5f6368]'}`}>
                    News, updates, and insights from the Constellation team
                </p>
            </div>

            {/* Blog Post */}
            <article className={`w-full ${isDarkMode ? 'bg-[#1a1a1a] border-gray-700' : 'bg-white border-gray-200'} border rounded-2xl p-8 md:p-12`}>
                {/* Post Header */}
                <header className="mb-8">
                    <h2 className={`text-3xl md:text-4xl font-semibold mb-4 ${isDarkMode ? 'text-white' : 'text-[#121317]'}`}>
                        {blogPost.title}
                    </h2>
                    <div className={`flex flex-wrap items-center gap-4 text-sm ${isDarkMode ? 'text-gray-400' : 'text-[#5f6368]'}`}>
                        <span>{blogPost.date}</span>
                        <span>•</span>
                        <span>{blogPost.author}</span>
                        <span>•</span>
                        <span>{blogPost.readTime}</span>
                    </div>
                </header>

                {/* Post Content */}
                <div className={`prose prose-lg ${isDarkMode ? 'prose-invert' : ''} max-w-none`}>
                    {blogPost.content.map((block, index) => {
                        if (block.type === 'paragraph') {
                            return (
                                <p key={index} className={`mb-6 text-base leading-relaxed ${isDarkMode ? 'text-gray-300' : 'text-[#45474d]'}`}>
                                    {block.text}
                                </p>
                            );
                        }
                        if (block.type === 'heading') {
                            return (
                                <h3 key={index} className={`text-2xl font-semibold mt-8 mb-4 ${isDarkMode ? 'text-white' : 'text-[#121317]'}`}>
                                    {block.text}
                                </h3>
                            );
                        }
                        if (block.type === 'list' && block.items) {
                            return (
                                <ul key={index} className={`mb-6 space-y-3 ${isDarkMode ? 'text-gray-300' : 'text-[#45474d]'}`}>
                                    {block.items.map((item, itemIndex) => (
                                        <li key={itemIndex} className="flex items-start">
                                            <svg className={`w-5 h-5 mr-3 mt-0.5 flex-shrink-0 ${isDarkMode ? 'text-blue-400' : 'text-[#1a73e8]'}`} fill="currentColor" viewBox="0 0 20 20">
                                                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                                            </svg>
                                            <span className="text-base">{item}</span>
                                        </li>
                                    ))}
                                </ul>
                            );
                        }
                        return null;
                    })}
                </div>

                {/* Post Footer CTA */}
                <div className={`mt-12 pt-8 border-t ${isDarkMode ? 'border-gray-700' : 'border-gray-200'}`}>
                    <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
                        <p className={`text-base ${isDarkMode ? 'text-gray-400' : 'text-[#5f6368]'}`}>
                            Ready to get started?
                        </p>
                        <Link
                            to="/downloads"
                            className="bg-[#1a73e8] text-white px-6 py-3 rounded-full font-medium hover:bg-[#1557b0] transition-colors"
                        >
                            Download Constellation
                        </Link>
                    </div>
                </div>
            </article>
        </div>
    );
};

export default Blog;
