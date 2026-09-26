import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { Link, matchRoute, navigate, runPath, usePathname } from './router.js';

/** The app's routes (docs/08 "Pages"): runs, a new run, and a run by its id. */

beforeEach(() => window.history.replaceState(null, '', '/'));

describe('matching a path', () => {
  it('knows the runs list, the new-run form and a run', () => {
    expect(matchRoute('/')).toEqual({ page: 'runs' });
    expect(matchRoute('/runs/')).toEqual({ page: 'runs' });
    expect(matchRoute('/runs/new')).toEqual({ page: 'newRun' });
    expect(matchRoute('/runs/abc-123')).toEqual({ page: 'run', runId: 'abc-123' });
  });

  it('round-trips a run id that needs escaping', () => {
    const id = 'a b/c';
    expect(matchRoute(runPath(id))).toEqual({ page: 'run', runId: id });
  });

  it('sends anything else, a malformed escape too, to not found', () => {
    expect(matchRoute('/runs/a/b').page).toBe('notFound');
    expect(matchRoute('/cards').page).toBe('notFound');
    expect(matchRoute('/runs/%E0%A4%A').page).toBe('notFound');
  });
});

const Where = () => <output>{usePathname()}</output>;

describe('navigating', () => {
  it('re-renders on a navigation and on the browser going back', () => {
    render(<Where />);
    expect(screen.getByRole('status').textContent).toBe('/');
    act(() => navigate('/runs/new'));
    expect(screen.getByRole('status').textContent).toBe('/runs/new');
    // The browser moving through history says so with popstate alone.
    act(() => {
      window.history.replaceState(null, '', '/runs/x');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(screen.getByRole('status').textContent).toBe('/runs/x');
  });

  it('follows a plain click on a link in place, and leaves a modified click to the browser', () => {
    render(
      <>
        <Link to="/runs/new">new</Link>
        <Where />
      </>,
    );
    const link = screen.getByRole('link', { name: 'new' });
    expect(link.getAttribute('href')).toBe('/runs/new');

    const modified = fireEvent.click(link, { ctrlKey: true });
    expect(modified).toBe(true); // not prevented: the browser opens a tab
    expect(screen.getByRole('status').textContent).toBe('/');

    const plain = fireEvent.click(link);
    expect(plain).toBe(false);
    expect(screen.getByRole('status').textContent).toBe('/runs/new');
  });
});
