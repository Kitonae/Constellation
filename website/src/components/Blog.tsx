import { Link } from 'react-router-dom';
import editorTimeline from '../assets/screenshots/editor-timeline.png';
import editorScreen from '../assets/screenshots/editor-screen.png';
import editorOutput from '../assets/screenshots/editor-output.png';
import editorShortcuts from '../assets/screenshots/editor-shortcuts.png';

interface BlogProps {
    isDarkMode: boolean;
}

type Block =
    | { type: 'paragraph'; text: string }
    | { type: 'heading'; text: string }
    | { type: 'list'; items: string[] }
    | { type: 'figure'; src: string; alt: string; caption: string };

interface Post {
    title: string;
    meta: string;
    content: Block[];
}

const Blog = ({ isDarkMode }: BlogProps) => {
    const posts: Post[] = [
        {
            title: 'What’s new: native output, drawn on the GPU',
            meta: 'Development update · In development',
            content: [
                {
                    type: 'paragraph',
                    text: 'The program that draws a show on stage is now a native Windows renderer built on Direct3D 12. Each renderer screen runs as its own process, reports its state back to the editor, and can be relaunched from the inspector without disturbing the rest of the show.',
                },
                {
                    type: 'figure',
                    src: editorTimeline,
                    alt: 'The Constellation editor: a media bin on the left, the 2D stage in the middle with a clip selected, the inspector on the right, and four timeline tracks along the bottom.',
                    caption: 'The editor: media bin, 2D stage, inspector and timeline in one window.',
                },
                {
                    type: 'heading',
                    text: 'Video that stays on the GPU',
                },
                {
                    type: 'paragraph',
                    text: 'H.264 decodes on the GPU’s own video engine, and the decoded frame stays in video memory as NV12 for the shader to sample where it already sits, rather than making a round trip through the CPU. HEVC, VP9 and AV1 play through the same path.',
                },
                {
                    type: 'heading',
                    text: 'The HAP family, natively',
                },
                {
                    type: 'paragraph',
                    text: 'Hap, Hap Alpha, Hap Q and Hap R play natively, decoded into compressed textures the GPU reads directly. A browser cannot decode these at all, so the editor thumbnails them natively too — a HAP clip looks like the rest of your media in the bin.',
                },
                {
                    type: 'heading',
                    text: 'Every output keeps its own clock',
                },
                {
                    type: 'paragraph',
                    text: 'Playback position comes from the desktop shell as an anchor: a position, whether it is moving, and the moment that was true. It goes out on every change and ten times a second while running, and the editor, each web output and each native renderer advance their own playhead from it.',
                },
                {
                    type: 'paragraph',
                    text: 'Nothing downstream waits to be told each new position, so a busy or hidden editor window no longer slows the picture on stage. A renderer launched into a show that is already running is caught up the moment it connects.',
                },
                {
                    type: 'figure',
                    src: editorScreen,
                    alt: 'The screen inspector in Constellation, showing a renderer screen named Screen 1 at 1920 by 1080, its stage position, a status line reading Renderer: ready, and a Relaunch control.',
                    caption: 'Selecting a renderer screen shows its state, resolution and a Relaunch control.',
                },
                {
                    type: 'heading',
                    text: 'Putting outputs on real displays',
                },
                {
                    type: 'paragraph',
                    text: 'The Output view draws the displays attached to the machine to scale, with every output window on them. Assigning a screen to a display is a drag across the map or a single Fill button, edges snap as you go, and Alt skips the snapping. A screen that has not been placed opens wherever Windows puts it.',
                },
                {
                    type: 'figure',
                    src: editorOutput,
                    alt: 'The Output view in Constellation: two displays drawn to scale side by side, with an output window named Screen 1 covering the primary 3440 by 1440 display, and controls to fill, unplace or relaunch it.',
                    caption: 'The Output view: displays drawn to scale, with each output window placed on them.',
                },
                {
                    type: 'heading',
                    text: 'Clear ownership, end to end',
                },
                {
                    type: 'list',
                    items: [
                        'The shell owns the open document: the file it came from, whether it differs from disk, and the bytes to write back',
                        'A show is validated and migrated once, on load, so the editor, the web outputs and the native renderer all see one shape',
                        'Anything this build has no opinion about is carried through untouched, so saving never drops it',
                        'Exactly one output plays the soundtrack, and hands it on if that output closes',
                    ],
                },
                {
                    type: 'heading',
                    text: 'Around the editor',
                },
                {
                    type: 'paragraph',
                    text: 'The shell moved to Wails v3, and settings arrived with four selectable themes and a choice of stage grid. Every colour, radius and shadow now comes from one set of design tokens. Undo works by the gesture you made rather than the internal steps behind it, and a single shortcut table drives the key handler, the menu accelerators and the help overlay together.',
                },
                {
                    type: 'figure',
                    src: editorShortcuts,
                    alt: 'The Keyboard Shortcuts overlay in Constellation, listing shortcuts grouped under File, Edit, Transport, Arrange, Viewport and Window.',
                    caption: 'One table, shown here as the help overlay, also drives the keys and the menu accelerators.',
                },
            ],
        },
        {
            title: 'Inside Constellation: Building a Show',
            meta: 'Product overview · In development',
            content: [
                {
                    type: 'paragraph',
                    text: 'A show takes shape through decisions about what appears, when it plays, and where it belongs on screen. Constellation is a desktop show editor in development that brings media preparation, timeline editing, stage composition, and display outputs into one workspace.',
                },
                {
                    type: 'heading',
                    text: 'Start with your media',
                },
                {
                    type: 'paragraph',
                    text: 'Drop files into the editor to build your media bin. Search, sort, and filter your assets, then drag them onto the timeline or stage. If a source file moves, relink it once to repair every clip that uses it.',
                },
                {
                    type: 'heading',
                    text: 'Find the timing',
                },
                {
                    type: 'paragraph',
                    text: 'Arrange clips across tracks, trim their edges, and split them at the playhead. Snapping helps align edits with other clips and the playhead. Scrub through the sequence, play it back, and adjust the timing as your show takes shape.',
                },
                {
                    type: 'heading',
                    text: 'Compose the stage',
                },
                {
                    type: 'paragraph',
                    text: 'Use the 2D stage to position screens and clips directly. Resize media with on-stage handles, pan across the composition, or frame a selection for a closer look. Save the show to a file so you can return to it and continue editing.',
                },
                {
                    type: 'heading',
                    text: 'Work with display outputs',
                },
                {
                    type: 'paragraph',
                    text: 'Screens can open as web output windows or native renderer outputs. Open, close, and reopen displays from the editor. For a native renderer, the screen inspector shows its status, frame rate, and errors, with a control to relaunch it.',
                },
                {
                    type: 'heading',
                    text: 'Still in development',
                },
                {
                    type: 'paragraph',
                    text: 'These workflows describe the current editor and continue to evolve. Public downloads are not yet available. Visit the development status page for availability, or explore the use cases for a closer look at how the pieces fit together.',
                },
            ],
        },
    ];

    return (
        <div className="flex flex-col items-center px-4 py-16 max-w-4xl mx-auto w-full">
            {/* Blog Header */}
            <div className="text-center mb-12">
                <h1 className={`text-[3rem] leading-[1.1] font-[450] ${isDarkMode ? 'text-white' : 'text-[#121317]'} mb-4`}>
                    Blog
                </h1>
                <p className={`text-xl ${isDarkMode ? 'text-gray-400' : 'text-[#5f6368]'}`}>
                    A closer look at the editor and the workflows taking shape.
                </p>
            </div>

            {/* Blog Posts */}
            <div className="flex flex-col gap-12 w-full">
                {posts.map((post) => (
                    <article key={post.title} className="glass-panel w-full p-8 md:p-12">
                        {/* Post Header */}
                        <header className="mb-8">
                            <h2 className={`text-3xl md:text-4xl font-semibold mb-4 ${isDarkMode ? 'text-white' : 'text-[#121317]'}`}>
                                {post.title}
                            </h2>
                            <p className={`text-sm ${isDarkMode ? 'text-gray-400' : 'text-[#5f6368]'}`}>{post.meta}</p>
                        </header>

                        {/* Post Content */}
                        <div className={`prose prose-lg ${isDarkMode ? 'prose-invert' : ''} max-w-none`}>
                            {post.content.map((block, index) => {
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
                                if (block.type === 'figure') {
                                    return (
                                        <figure key={index} className="my-8 -mx-2 sm:mx-0">
                                            <img
                                                src={block.src}
                                                alt={block.alt}
                                                loading="lazy"
                                                width={1800}
                                                height={1150}
                                                className={`w-full h-auto rounded-lg border ${isDarkMode ? 'border-gray-700' : 'border-gray-300'}`}
                                            />
                                            <figcaption className={`mt-3 text-sm text-center ${isDarkMode ? 'text-gray-400' : 'text-[#5f6368]'}`}>
                                                {block.caption}
                                            </figcaption>
                                        </figure>
                                    );
                                }
                                if (block.type === 'list') {
                                    return (
                                        <ul key={index} className={`mb-6 space-y-3 ${isDarkMode ? 'text-gray-300' : 'text-[#45474d]'}`}>
                                            {block.items.map((item, itemIndex) => (
                                                <li key={itemIndex} className="flex items-start">
                                                    <svg aria-hidden="true" className={`w-5 h-5 mr-3 mt-0.5 flex-shrink-0 ${isDarkMode ? 'text-blue-400' : 'text-[#1a73e8]'}`} fill="currentColor" viewBox="0 0 20 20">
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
                    </article>
                ))}
            </div>

            {/* Footer CTA */}
            <div className={`mt-12 w-full pt-8 border-t ${isDarkMode ? 'border-gray-700' : 'border-gray-200'}`}>
                <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
                    <p className={`text-base ${isDarkMode ? 'text-gray-400' : 'text-[#5f6368]'}`}>
                        Public downloads are not yet available.
                    </p>
                    <Link
                        to="/downloads"
                        className="bg-[#1a73e8] text-white px-6 py-3 rounded-full font-medium hover:bg-[#1557b0] transition-colors"
                    >
                        Development status
                    </Link>
                </div>
            </div>
        </div>
    );
};

export default Blog;
