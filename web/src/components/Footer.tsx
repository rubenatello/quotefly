export function Footer() {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="border-t border-slate-200 bg-white px-4 py-12 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {/* Brand */}
          <div>
            <h3 className="text-lg font-bold text-slate-900">QuoteFly</h3>
            <p className="mt-2 text-sm text-slate-600">Quotes in seconds, not hours.</p>
            <div className="mt-4 flex gap-4">
              <a href="#" className="text-slate-600 hover:text-slate-900 transition-colors">
                Twitter
              </a>
              <a href="#" className="text-slate-600 hover:text-slate-900 transition-colors">
                LinkedIn
              </a>
            </div>
          </div>

          {/* Product */}
          <div>
            <h4 className="font-semibold text-slate-900">Product</h4>
            <ul className="mt-4 space-y-2 text-sm text-slate-600">
              <li>
                <a href="#" className="hover:text-slate-900 transition-colors">
                  Pricing
                </a>
              </li>
              <li>
                <a href="#" className="hover:text-white transition-colors">
                  Solutions
                </a>
              </li>
              <li>
                <a href="#" className="hover:text-white transition-colors">
                  Blog
                </a>
              </li>
              <li>
                <a href="#" className="hover:text-white transition-colors">
                  Roadmap
                </a>
              </li>
            </ul>
          </div>

          {/* Company */}
          <div>
            <h4 className="font-semibold text-slate-900">Company</h4>
            <ul className="mt-4 space-y-2 text-sm text-slate-600">
              <li>
                <a href="#" className="hover:text-slate-900 transition-colors">
                  About
                </a>
              </li>
              <li>
                <a href="#" className="hover:text-white transition-colors">
                  Contact
                </a>
              </li>
              <li>
                <a href="#" className="hover:text-white transition-colors">
                  Careers
                </a>
              </li>
              <li>
                <a href="#" className="hover:text-white transition-colors">
                  Partners
                </a>
              </li>
            </ul>
          </div>

          {/* Legal */}
          <div>
            <h4 className="font-semibold text-slate-900">Legal</h4>
            <ul className="mt-4 space-y-2 text-sm text-slate-600">
              <li>
                <a href="#" className="hover:text-slate-900 transition-colors">
                  Terms
                </a>
              </li>
              <li>
                <a href="#" className="hover:text-white transition-colors">
                  Privacy
                </a>
              </li>
              <li>
                <a href="#" className="hover:text-white transition-colors">
                  Security
                </a>
              </li>
              <li>
                <a href="#" className="hover:text-white transition-colors">
                  Cookie Policy
                </a>
              </li>
            </ul>
          </div>
        </div>

        {/* Copyright */}
        <div className="mt-8 border-t border-slate-200 pt-8 text-center text-sm text-slate-500">
          <p>&copy; {currentYear} QuoteFly. All rights reserved.</p>
        </div>
      </div>
    </footer>
  );
}
