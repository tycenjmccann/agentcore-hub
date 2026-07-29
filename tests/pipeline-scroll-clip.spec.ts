import { test, expect } from '@playwright/test';

test.describe('Pipeline scroll clip regression', () => {
  test('Phase board content is not clipped on the left when container is narrower than content', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });

    await page.setContent(`
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        .pipeline-viz {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          overflow-x: auto;
          padding: 14px 20px;
          width: 100%;
        }
        .pipeline-canvas {
          position: relative;
          width: 1720px;
          min-height: 200px;
          margin-inline: auto;
          background: #1a1a2e;
        }
        .pipeline-top-bar {
          display: flex;
          align-items: center;
          width: 1720px;
          margin-bottom: 10px;
          margin-inline: auto;
        }
        .pipeline-phases {
          display: flex;
          align-items: flex-start;
          gap: 44px;
        }
        .phase {
          width: 290px;
          height: 150px;
          background: #2a2a4a;
          border-radius: 11px;
          flex-shrink: 0;
        }
      </style>
      <div class="pipeline-viz" id="scroll-container">
        <div class="pipeline-top-bar">Top bar</div>
        <div class="pipeline-canvas" id="canvas">
          <div class="pipeline-phases">
            <div class="phase" id="phase-1">Phase 1 - Intake</div>
            <div class="phase">Phase 2</div>
            <div class="phase">Phase 3</div>
            <div class="phase">Phase 4</div>
            <div class="phase">Phase 5</div>
          </div>
        </div>
      </div>
    `);

    await page.evaluate(() => {
      const container = document.getElementById('scroll-container')!;
      container.scrollLeft = 0;
    });

    const result = await page.evaluate(() => {
      const container = document.getElementById('scroll-container')!;
      const canvas = document.getElementById('canvas')!;
      const phase1 = document.getElementById('phase-1')!;

      const containerRect = container.getBoundingClientRect();
      const phase1Rect = phase1.getBoundingClientRect();

      return {
        scrollLeft: container.scrollLeft,
        canvasOffsetLeft: canvas.offsetLeft,
        phase1LeftRelativeToContainer: phase1Rect.left - containerRect.left,
        scrollWidth: container.scrollWidth,
        clientWidth: container.clientWidth,
        containerPaddingLeft: parseInt(getComputedStyle(container).paddingLeft),
      };
    });

    expect(result.canvasOffsetLeft).toBeGreaterThanOrEqual(0);
    expect(result.phase1LeftRelativeToContainer).toBeGreaterThanOrEqual(result.containerPaddingLeft);
    expect(result.scrollLeft).toBe(0);
  });

  test('Phase board centers when viewport is wider than content', async ({ page }) => {
    await page.setViewportSize({ width: 2200, height: 768 });

    await page.setContent(`
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        .pipeline-viz {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          overflow-x: auto;
          padding: 14px 20px;
          width: 100%;
        }
        .pipeline-canvas {
          position: relative;
          width: 1720px;
          min-height: 200px;
          margin-inline: auto;
          background: #1a1a2e;
        }
        .pipeline-top-bar {
          display: flex;
          align-items: center;
          width: 1720px;
          margin-bottom: 10px;
          margin-inline: auto;
        }
      </style>
      <div class="pipeline-viz" id="scroll-container">
        <div class="pipeline-top-bar">Top bar</div>
        <div class="pipeline-canvas" id="canvas">
          <div style="width:100%;height:200px;background:#2a2a4a;">Content</div>
        </div>
      </div>
    `);

    const result = await page.evaluate(() => {
      const container = document.getElementById('scroll-container')!;
      const canvas = document.getElementById('canvas')!;

      const containerRect = container.getBoundingClientRect();
      const canvasRect = canvas.getBoundingClientRect();

      const leftSpace = canvasRect.left - containerRect.left;
      const rightSpace = containerRect.right - canvasRect.right;

      return {
        leftSpace,
        rightSpace,
        difference: Math.abs(leftSpace - rightSpace),
        noHorizontalScroll: container.scrollWidth <= container.clientWidth,
      };
    });

    expect(result.difference).toBeLessThanOrEqual(2);
    expect(result.noHorizontalScroll).toBe(true);
  });
});
