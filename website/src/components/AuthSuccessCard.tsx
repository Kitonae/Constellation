
const AuthSuccessCard: React.FC = () => {
    return (
        <div className="flex flex-col items-center text-center max-w-md mx-auto px-4">
            <div className="w-16 h-16 bg-green-500 rounded-full flex items-center justify-center mb-6 text-ag-black">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                </svg>
            </div>
            <h2 className="text-2xl font-bold text-white mb-4">You have successfully authenticated.</h2>
            <p className="text-ag-text-muted mb-8 leading-relaxed">
                You should be redirected back to the product.
                <br />
                <a href="antigravity://oauth-success" className="text-blue-400 hover:text-blue-300 underline decoration-blue-400/30 hover:decoration-blue-300 transition-all">
                    Click here if not working.
                </a>
            </p>
        </div>
    );
};

export default AuthSuccessCard;
